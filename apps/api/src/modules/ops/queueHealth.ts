import { Queue } from "bullmq";
import { prisma } from "../../db/client.js";
import { getRedisConnection } from "../../queue/connection.js";
import { MAILBOX_SYNC_QUEUE, getMailboxSyncQueue } from "../../queue/mailboxSyncQueue.js";
import { PROCESS_EMAIL_QUEUE } from "../../queue/queues.js";
import { EXECUTE_ACTION_QUEUE } from "../../queue/executeActionQueue.js";
import { REVIEW_DIGEST_QUEUE } from "../../queue/reviewDigestQueue.js";
import { FORWARD_DIGEST_QUEUE } from "../../queue/forwardDigestQueue.js";
import { OPS_ALERTS_QUEUE } from "../../queue/opsAlertsQueue.js";
import { readIdleStates } from "../mail-providers/imap/idle.js";

/**
 * Phase 26: sync and queue health, readable without Redis tools.
 *
 *   queueHealth()      per queue: waiting / active / delayed / failed counts and
 *                      the latest failures with their reason (global — the
 *                      queues are shared, so this is the system owner's view)
 *   mailboxHealth()    an organization's mailboxes, problems first: never
 *                      synced, failing since its last success, or needing a
 *                      new sign-in
 *   cleanupSyncJobs()  run by the maintenance tick: drops failed sync jobs older
 *                      than FAILED_RETENTION_DAYS and, right away, failed jobs of
 *                      mailboxes that no longer exist, are disabled or wait for a
 *                      new password (reauth_required); removes
 *                      the repeat schedule of mailboxes that no longer exist.
 *                      Queue bookkeeping only — no email data is touched.
 */
export const FAILED_RETENTION_DAYS = 7;
const RECENT_FAILURES = 10;
export const QUEUE_NAMES = [MAILBOX_SYNC_QUEUE, PROCESS_EMAIL_QUEUE, EXECUTE_ACTION_QUEUE, REVIEW_DIGEST_QUEUE, FORWARD_DIGEST_QUEUE, OPS_ALERTS_QUEUE, "maintenance"]; // maintenanceQueue.ts imports this module — name inlined to avoid a cycle

export interface QueueHealth {
  name: string;
  counts: { waiting: number; active: number; delayed: number; failed: number; completed: number };
  recentFailures: Array<{ id: string; name: string; failedAt: string | null; reason: string; attempts: number; mailboxConnectionId?: string }>;
}

export async function queueHealth(): Promise<QueueHealth[]> {
  const out: QueueHealth[] = [];
  for (const name of QUEUE_NAMES) {
    const queue = new Queue(name, { connection: getRedisConnection() });
    try {
      const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed", "completed");
      const failed = await queue.getFailed(0, RECENT_FAILURES - 1);
      out.push({
        name,
        counts: { waiting: counts.waiting ?? 0, active: counts.active ?? 0, delayed: counts.delayed ?? 0, failed: counts.failed ?? 0, completed: counts.completed ?? 0 },
        recentFailures: failed
          .filter((j): j is NonNullable<typeof j> => Boolean(j))
          .map((j) => ({
            id: String(j.id),
            name: j.name,
            failedAt: j.finishedOn ? new Date(j.finishedOn).toISOString() : null,
            reason: (j.failedReason ?? "").slice(0, 500),
            attempts: j.attemptsMade,
            ...(typeof (j.data as { mailboxConnectionId?: unknown })?.mailboxConnectionId === "string" ? { mailboxConnectionId: (j.data as { mailboxConnectionId: string }).mailboxConnectionId } : {}),
          })),
      });
    } finally {
      await queue.close();
    }
  }
  return out;
}

export interface MailboxHealth {
  id: string;
  name: string | null;
  emailAddress: string;
  status: string;
  lastSyncSuccessAt: string | null;
  lastSyncFailureAt: string | null;
  lastSyncError: string | null;
  /** Syncs failed in a row since the last success. */
  consecutiveFailures: number;
  health: "ok" | "failing" | "never_synced" | "needs_sign_in" | "disabled";
  /** 1.1 (C): the worker holds an open IDLE connection for it — new mail arrives within seconds. */
  live: boolean;
}

const RANK: Record<MailboxHealth["health"], number> = { needs_sign_in: 0, failing: 1, never_synced: 2, ok: 3, disabled: 4 };

export async function mailboxHealth(tenantId: string): Promise<MailboxHealth[]> {
  const rows = await prisma.mailboxConnection.findMany({ where: { tenantId }, orderBy: { emailAddress: "asc" } });
  const idle = await readIdleStates(getRedisConnection());
  return rows
    .map((m) => {
      const failing = m.lastSyncFailureAt !== null && (m.lastSyncSuccessAt === null || m.lastSyncFailureAt > m.lastSyncSuccessAt);
      const health: MailboxHealth["health"] =
        m.status === "disabled" ? "disabled" : m.status === "reauth_required" ? "needs_sign_in" : failing ? "failing" : m.lastSyncSuccessAt === null ? "never_synced" : "ok";
      return {
        id: m.id,
        name: m.name,
        emailAddress: m.emailAddress,
        status: m.status,
        lastSyncSuccessAt: m.lastSyncSuccessAt?.toISOString() ?? null,
        lastSyncFailureAt: m.lastSyncFailureAt?.toISOString() ?? null,
        lastSyncError: m.lastSyncError,
        consecutiveFailures: m.consecutiveSyncFailures,
        health,
        live: m.status === "active" && idle.get(m.id)?.state === "live",
      };
    })
    .sort((a, b) => RANK[a.health] - RANK[b.health] || b.consecutiveFailures - a.consecutiveFailures);
}

export interface SyncCleanupResult {
  removedOld: number;
  removedOrphaned: number;
  removedSchedules: number;
}

export async function cleanupSyncJobs(): Promise<SyncCleanupResult> {
  const queue = getMailboxSyncQueue();
  const removedOld = (await queue.clean(FAILED_RETENTION_DAYS * 24 * 60 * 60 * 1000, 10_000, "failed")).length;

  const failed = (await queue.getFailed(0, 9_999)).filter((j): j is NonNullable<typeof j> => Boolean(j));
  const schedulers = await queue.getJobSchedulers(0, 9_999);
  const ids = new Set<string>([
    ...failed.map((j) => j.data?.mailboxConnectionId).filter((id): id is string => typeof id === "string"),
    ...schedulers.map((s) => /^mailbox-sync:(.+)$/.exec(String(s.key ?? s.id ?? ""))?.[1]).filter((id): id is string => Boolean(id)),
  ]);
  const mailboxes = await prisma.mailboxConnection.findMany({ where: { id: { in: [...ids] } }, select: { id: true, status: true } });
  const status = new Map(mailboxes.map((m) => [m.id, m.status]));

  let removedOrphaned = 0;
  for (const job of failed) {
    const id = job.data?.mailboxConnectionId;
    const s = typeof id === "string" ? status.get(id) : undefined;
    if (s === undefined || s === "disabled" || s === "reauth_required") {
      await job.remove();
      removedOrphaned += 1;
    }
  }
  let removedSchedules = 0;
  for (const s of schedulers) {
    const key = String(s.key ?? s.id ?? "");
    const id = /^mailbox-sync:(.+)$/.exec(key)?.[1];
    if (id && !status.has(id)) {
      await queue.removeJobScheduler(key);
      removedSchedules += 1;
    }
  }
  return { removedOld, removedOrphaned, removedSchedules };
}
