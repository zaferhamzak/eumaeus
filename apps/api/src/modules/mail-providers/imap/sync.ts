import { prisma } from "../../../db/client.js";
import { unscheduleMailboxSync } from "../../../queue/mailboxSyncQueue.js";
import { recordAuditEvent, AuditEventType } from "../../audit/record.js";
import { persistNormalizedEmail } from "../../ingestion/persist.js";
import { parseImapMessage } from "./parse.js";
import { ImapFlowMailClient, type ImapClientPort } from "./client.js";
import { resolveMailboxSecret } from "./mailboxAuth.js";
import { loadEnv } from "../../../config/env.js";
import { metrics } from "../../../metrics/metrics.js";
import { MetricName } from "../../../metrics/names.js";

export interface SyncResult {
  mailboxConnectionId: string;
  discovered: number;
  alreadyKnown: number;
  uidValidityChanged: boolean;
  /**
   * True when this call did not actually talk to IMAP because another sync for the
   * same mailbox was already in progress (see the mailbox-level lock below).
   * Additive field, not a discriminated union — existing callers that only read
   * discovered/alreadyKnown/uidValidityChanged keep working unchanged; they will
   * just see all-zero/false values on a skipped run.
   */
  skipped: boolean;
  skipReason?: "concurrent_sync_in_progress" | "mailbox_deleted" | "mailbox_disabled" | "organization_disabled";
}

interface ProviderConfig {
  host: string;
  port: number;
  tls: boolean;
  folder: string;
  username: string;
}

/**
 * How long a "syncing" lock is honored before a later caller is allowed to treat it
 * as abandoned (e.g. the worker holding it crashed) and try again. A real IMAP sync
 * should take seconds, at most low minutes even for a large mailbox — 10 minutes is
 * a deliberately generous fixed ceiling, not something that needs to scale with the
 * configured reconciliation interval.
 */
const STALE_LOCK_MS = 2 * 60 * 1000;
/**
 * 1.0: a running sync refreshes its lock every LOCK_REFRESH_MS, so a lock is
 * "stale" only when nobody has refreshed it for STALE_LOCK_MS — a sync that
 * died with its process (a restart mid-sync) frees the mailbox within two
 * minutes instead of silencing it for ten, while a genuinely long first sync
 * keeps its lock for as long as it runs.
 */
const LOCK_REFRESH_MS = 30 * 1000;
/** Mailboxes this process is syncing right now (released on graceful shutdown). */
const activeSyncs = new Set<string>();

async function refreshSyncLock(mailboxConnectionId: string): Promise<void> {
  await prisma.mailboxConnection.updateMany({ where: { id: mailboxConnectionId, syncStatus: "syncing" }, data: { syncLockedAt: new Date() } });
}

/** Called by the worker's shutdown: syncs it had to abandon give their mailbox back at once. */
export async function releaseActiveSyncLocks(): Promise<number> {
  if (activeSyncs.size === 0) return 0;
  const result = await prisma.mailboxConnection.updateMany({ where: { id: { in: [...activeSyncs] }, syncStatus: "syncing" }, data: { syncStatus: "idle", syncLockedAt: null } });
  activeSyncs.clear();
  return result.count;
}

/**
 * Attempts to acquire the mailbox-level sync lock via a single atomic conditional
 * UPDATE. This is the ENTIRE concurrency mechanism (implementation-plan.md's
 * "smallest correct mechanism" instruction): no separate lock table, no advisory
 * lock, no distributed lock service. Postgres itself serializes two concurrent
 * UPDATE...WHERE statements against the same row — only one can ever see the WHERE
 * condition as true, so this is race-free regardless of which process/mechanism
 * calls syncMailbox() (manual CLI, the scheduler, or anything later), which is
 * exactly the guarantee needed since the manual `pnpm sync` path never goes through
 * BullMQ at all and so could never be protected by a queue-level dedup alone.
 */
async function tryAcquireSyncLock(mailboxConnectionId: string): Promise<boolean> {
  const staleCutoff = new Date(Date.now() - STALE_LOCK_MS);
  const result = await prisma.mailboxConnection.updateMany({
    where: {
      id: mailboxConnectionId,
      OR: [{ syncStatus: { not: "syncing" } }, { syncLockedAt: { lt: staleCutoff } }],
    },
    data: { syncStatus: "syncing", syncLockedAt: new Date(), lastSyncAttemptAt: new Date() },
  });
  return result.count === 1;
}

async function releaseSyncLockSuccess(
  mailboxConnectionId: string,
  cursor: { lastUidValidity: number; lastSyncedUid: number },
): Promise<void> {
  await prisma.mailboxConnection.update({
    where: { id: mailboxConnectionId },
    data: {
      syncStatus: "idle",
      syncLockedAt: null,
      lastSyncSuccessAt: new Date(),
      consecutiveSyncFailures: 0,
      lastUidValidity: cursor.lastUidValidity,
      lastSyncedUid: cursor.lastSyncedUid,
    },
  });
}

async function releaseSyncLockFailure(mailboxConnectionId: string, errorMessage: string): Promise<void> {
  // Deliberately does NOT touch lastUidValidity/lastSyncedUid — the cursor must
  // remain exactly where the last successful sync left it (this phase's "cursor
  // correctness must remain intact" requirement).
  await prisma.mailboxConnection.update({
    where: { id: mailboxConnectionId },
    data: {
      syncStatus: "failed",
      syncLockedAt: null,
      lastSyncFailureAt: new Date(),
      lastSyncError: errorMessage,
      consecutiveSyncFailures: { increment: 1 },
    },
  });
}

/**
 * Discovers and persists new messages for one mailbox connection.
 *
 * This is the SINGLE ingestion entry point (implementation-plan.md §F): whether it
 * is invoked manually (`pnpm sync`), by the Phase 2 reconciliation scheduler, or by
 * a future Pub/Sub-style push trigger, they all just call this same function. There
 * is exactly one implementation of "how to sync a mailbox," so every trigger path
 * shares the same idempotency, cursor, and locking guarantees automatically.
 *
 * Idempotency and no-loss guarantee (implementation-plan.md §G):
 *   - Every persisted message goes through persistNormalizedEmail, which is safe to
 *     call twice for the same UID (see that module's docs).
 *   - The sync cursor (lastSyncedUid / lastUidValidity) is only advanced AFTER the
 *     whole fetch loop completes without throwing. If the connection drops or an
 *     error occurs partway through, whatever was already persisted stays persisted,
 *     the cursor simply does not move forward, and the next run safely re-fetches
 *     the same UID range.
 *   - Concurrency: a mailbox-level lock (see tryAcquireSyncLock above) ensures two
 *     overlapping calls for the SAME mailbox — e.g. a manual `pnpm sync` racing the
 *     scheduler — never run their fetch/persist loop at the same time. The database
 *     unique constraint on Email remains the final backstop regardless (Phase 1),
 *     but the lock avoids wasted duplicate IMAP round-trips and, more importantly,
 *     avoids two concurrent cursor-advance writes stepping on each other.
 */
export async function syncMailbox(
  mailboxConnectionId: string,
  clientFactory?: (config: ProviderConfig, password: string) => ImapClientPort,
): Promise<SyncResult> {
  // A mailbox can be deleted while its repeatable sync job is still queued. The
  // job then fires against a row that no longer exists; findUniqueOrThrow would
  // throw and BullMQ would retry it forever, so a deleted mailbox permanently
  // poisons the failed-job list. Treat it as a no-op skip instead.
  const mailboxConnection = await prisma.mailboxConnection.findUnique({
    where: { id: mailboxConnectionId },
    include: { tenant: { select: { status: true } } },
  });
  // A disabled mailbox is skipped for the same reason: its repeatable job is
  // still scheduled, so attempting the sync would fail on every tick forever.
  // So is every mailbox of a deactivated organization — deactivating it stops
  // its mail coming in; reactivating resumes where the cursor left off.
  if (!mailboxConnection || mailboxConnection.status !== "active" || mailboxConnection.tenant.status !== "active") {
    metrics.increment(MetricName.MAILBOX_SYNC_RESULT, { result: "skipped" });
    return {
      mailboxConnectionId,
      discovered: 0,
      alreadyKnown: 0,
      uidValidityChanged: false,
      skipped: true,
      skipReason: !mailboxConnection ? "mailbox_deleted" : mailboxConnection.status !== "active" ? "mailbox_disabled" : "organization_disabled",
    };
  }

  metrics.increment(MetricName.MAILBOX_SYNC_ATTEMPT);

  const lockAcquired = await tryAcquireSyncLock(mailboxConnectionId);
  if (!lockAcquired) {
    await recordAuditEvent(prisma, {
      tenantId: mailboxConnection.tenantId,
      eventType: AuditEventType.MAILBOX_SYNC_SKIPPED_CONCURRENT,
      actor: "system",
      payload: { mailboxConnectionId },
    });
    metrics.increment(MetricName.MAILBOX_SYNC_RESULT, { result: "skipped" });
    return {
      mailboxConnectionId,
      discovered: 0,
      alreadyKnown: 0,
      uidValidityChanged: false,
      skipped: true,
      skipReason: "concurrent_sync_in_progress",
    };
  }

  const config = mailboxConnection.providerConfig as unknown as ProviderConfig;
  const env = loadEnv();

  await recordAuditEvent(prisma, {
    tenantId: mailboxConnection.tenantId,
    eventType: AuditEventType.MAILBOX_SYNC_STARTED,
    actor: "system",
    payload: { mailboxConnectionId },
  });

  let discovered = 0;
  let alreadyKnown = 0;
  let uidValidityChanged = false;
  let maxUidSeen: number | undefined;
  // Declared outside the try block so the `finally` below can still attempt
  // client.close() if construction succeeded but a later step threw —
  // undefined only if credential resolution itself failed before the client
  // ever existed, in which case there is nothing to close.
  let client: ImapClientPort | undefined;
  // Which step failed — "Command failed" alone doesn't say (see describeSyncError).
  let stage: SyncStage = "credentials";
  activeSyncs.add(mailboxConnectionId);
  const lockHeartbeat = setInterval(() => void refreshSyncLock(mailboxConnectionId).catch(() => {}), LOCK_REFRESH_MS);
  lockHeartbeat.unref();

  try {
    // Phase 10: each mailbox's OWN encrypted credential, not a single global
    // MAIL_PASSWORD — see mailboxCredentials.ts. A mailbox created through
    // the API (or the legacy bootstrap mailbox, migrated by
    // ensureBootstrapMailbox) always has exactly one MailboxCredential row;
    // a missing one fails this sync attempt loudly — caught by this same
    // try/catch, so the sync lock is always released and MAILBOX_SYNC_FAILED
    // is always recorded, exactly like any other sync failure.
    // Phase 17: an OAuth mailbox gets a fresh access token instead (refreshed
    // if needed; a revoked sign-in marks the mailbox reauth_required).
    const secret = await resolveMailboxSecret(mailboxConnection);
    client = clientFactory
      ? clientFactory(config, secret.value)
      : new ImapFlowMailClient({
          host: config.host,
          port: config.port,
          tls: config.tls,
          username: config.username,
          secret,
        });

    stage = "connect";
    await client.connect();
    stage = "open_folder";
    const status = await client.openMailbox(config.folder);

    let startUid: number;

    if (mailboxConnection.lastUidValidity == null) {
      // First sync for this mailbox connection.
      startUid = 1;
      if (env.MAIL_INITIAL_SYNC_LIMIT && status.uidNext > env.MAIL_INITIAL_SYNC_LIMIT) {
        startUid = Math.max(1, status.uidNext - env.MAIL_INITIAL_SYNC_LIMIT);
      }
    } else if (mailboxConnection.lastUidValidity !== status.uidValidity) {
      // The server reassigned UIDs (UIDVALIDITY changed) — historical UIDs we
      // stored are no longer trustworthy references into this mailbox. Documented
      // response: start a fresh baseline from here forward rather than attempting
      // to reconcile identity across the epoch change. Already-persisted rows from
      // the old epoch are left exactly as they are — a deliberate, documented scope
      // decision, not a silent gap.
      uidValidityChanged = true;
      startUid = 1;
      await recordAuditEvent(prisma, {
        tenantId: mailboxConnection.tenantId,
        eventType: AuditEventType.MAILBOX_UIDVALIDITY_CHANGED,
        actor: "system",
        payload: {
          mailboxConnectionId,
          previousUidValidity: mailboxConnection.lastUidValidity,
          newUidValidity: status.uidValidity,
        },
      });
    } else {
      startUid = (mailboxConnection.lastSyncedUid ?? 0) + 1;
    }

    stage = "fetch";
    for await (const message of client.fetchMessagesFrom(startUid)) {
      stage = "store";
      const normalized = await parseImapMessage(message);
      const { created } = await persistNormalizedEmail(mailboxConnection.tenantId, mailboxConnectionId, normalized);
      if (created) discovered += 1;
      else alreadyKnown += 1;
      maxUidSeen = maxUidSeen === undefined ? message.uid : Math.max(maxUidSeen, message.uid);
      stage = "fetch";
    }

    // A successful sync that finds nothing new is still a successful sync — "no new
    // email" must not be confused with "no synchronization happened." The cursor
    // (uidValidity) and the health fields (syncStatus/lastSyncSuccessAt) are always
    // updated here on the success path, whether or not any message was fetched.
    await releaseSyncLockSuccess(mailboxConnectionId, {
      lastUidValidity: status.uidValidity,
      lastSyncedUid: maxUidSeen ?? mailboxConnection.lastSyncedUid ?? 0,
    });

    await recordAuditEvent(prisma, {
      tenantId: mailboxConnection.tenantId,
      eventType: AuditEventType.MAILBOX_SYNC_COMPLETED,
      actor: "system",
      payload: { mailboxConnectionId, discovered, alreadyKnown, uidValidityChanged },
    });
    metrics.increment(MetricName.MAILBOX_SYNC_RESULT, { result: "success" });

    return { mailboxConnectionId, discovered, alreadyKnown, uidValidityChanged, skipped: false };
  } catch (error) {
    // Explicit failure, not a silently swallowed one: recorded in the audit trail,
    // reflected in the mailbox's health fields, and re-thrown so the caller (CLI
    // script or the BullMQ worker, which will apply its own retry/backoff) sees it
    // fail loudly. The cursor was never advanced above, so nothing here has
    // corrupted sync state — the next run resumes from exactly where the last
    // successful run left off.
    const errorMessage = describeSyncError(error, stage, maxUidSeen);
    await releaseSyncLockFailure(mailboxConnectionId, errorMessage);
    // A password the server keeps rejecting won't start working by retrying
    // every minute — and providers lock accounts that keep failing sign-in.
    // After a few rejections in a row the mailbox waits for a new password.
    if (isSignInRejected(error) && mailboxConnection.authType === "password") {
      await stopAfterRepeatedRejection(mailboxConnection.tenantId, mailboxConnectionId, errorMessage);
    }
    await recordAuditEvent(prisma, {
      tenantId: mailboxConnection.tenantId,
      eventType: AuditEventType.MAILBOX_SYNC_FAILED,
      actor: "system",
      payload: { mailboxConnectionId, errorMessage },
    });
    metrics.increment(MetricName.MAILBOX_SYNC_RESULT, { result: "failure" });
    throw error;
  } finally {
    clearInterval(lockHeartbeat);
    activeSyncs.delete(mailboxConnectionId);
    // `client` is undefined only when credential resolution itself failed
    // before any IMAP client was ever constructed — nothing to close.
    await client?.close().catch(() => {
      // Best-effort close — a failure to log out cleanly must not mask the real
      // error from the try block above, and must not throw past this finally.
    });
  }
}

type SyncStage = "credentials" | "connect" | "open_folder" | "fetch" | "store";

const STAGE_LABEL: Record<SyncStage, string> = {
  credentials: "reading the mailbox's credentials",
  connect: "connecting / signing in",
  open_folder: "opening the folder",
  fetch: "fetching new messages",
  store: "storing a message",
};

/**
 * The stored lastSyncError. imapflow's own message is often just "Command
 * failed"; what the server actually said is on the error's responseText /
 * serverResponseCode (and a sign-in failure is flagged separately). Never
 * includes credentials — those fields hold the server's reply only.
 */
export function describeSyncError(error: unknown, stage: SyncStage, lastStoredUid?: number): string {
  const e = (error ?? {}) as { message?: string; responseText?: string; serverResponseCode?: string; responseStatus?: string; authenticationFailed?: boolean; code?: string };
  const base = error instanceof Error ? error.message : String(error);
  const details = [
    e.authenticationFailed ? "sign-in rejected" : null,
    e.serverResponseCode ? `[${e.serverResponseCode}]` : null,
    e.responseText && e.responseText !== base ? `server said: ${e.responseText}` : null,
    e.code && !base.includes(e.code) ? e.code : null,
    stage === "fetch" && lastStoredUid !== undefined ? `after UID ${lastStoredUid}` : null,
  ].filter(Boolean);
  return `${base} (while ${STAGE_LABEL[stage]}${details.length ? `; ${details.join("; ")}` : ""})`.slice(0, 1000);
}

/** How many sign-in rejections in a row before a password mailbox stops trying. */
export const MAX_SIGN_IN_REJECTIONS = 3;

function isSignInRejected(error: unknown): boolean {
  return Boolean((error as { authenticationFailed?: boolean } | null)?.authenticationFailed);
}

async function stopAfterRepeatedRejection(tenantId: string, mailboxConnectionId: string, errorMessage: string): Promise<void> {
  const row = await prisma.mailboxConnection.findUnique({ where: { id: mailboxConnectionId }, select: { consecutiveSyncFailures: true, status: true } });
  if (!row || row.status !== "active" || row.consecutiveSyncFailures < MAX_SIGN_IN_REJECTIONS) return;
  await prisma.mailboxConnection.update({
    where: { id: mailboxConnectionId },
    data: { status: "reauth_required", lastSyncError: `Sign-in rejected ${row.consecutiveSyncFailures} times in a row — update the password. ${errorMessage}`.slice(0, 1000) },
  });
  await unscheduleMailboxSync(mailboxConnectionId);
  await recordAuditEvent(prisma, { tenantId, eventType: AuditEventType.MAILBOX_REAUTH_REQUIRED, actor: "system", payload: { mailboxConnectionId, reason: "password_rejected" } });
}
