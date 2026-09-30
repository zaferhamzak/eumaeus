import type { ImapMoveResult } from "../../mail-providers/imap/archiveClient.js";
import { ARCHIVE_EXECUTOR_TIMEOUT_MS } from "../idempotency.js";
import type { ArchiveChannelConfig } from "../types.js";
import { applyFlags, hasFlagOptions, openImapSession, withTimeout, type ArchiveClientFactory } from "./imapSession.js";
import type { DestinationExecutor, ExecutionContext, ExecutionOutcome } from "./types.js";

/**
 * One of the few files in modules/destinations/ that talk IMAP (with
 * imapSession.ts, flagExecutor.ts and archiveUndo.ts; enforced by
 * test/architecture/destinationsModuleBoundary.test.ts).
 *
 * Phase 15: optional flags (read / starred / keywords or Gmail labels) are
 * set BEFORE the move, in this same executor, so there's never a race
 * between a separate flag channel and the move. Where the message landed
 * (new UID + UIDVALIDITY, when the server reports them) and the source folder
 * are recorded in responseMetadata so the move can be undone (archiveUndo.ts).
 *
 * Idempotency, worked out from what the real provider abstraction can and cannot
 * tell us (this phase's explicit instruction: do not assume "archive is naturally
 * idempotent," verify it against ImapArchiveClientPort's actual contract):
 *
 *   Case A — message already archived (by this or an earlier attempt): a UID
 *     command that finds nothing to act on is not an IMAP error, it just matches
 *     zero messages — ImapArchiveClientPort.moveMessage() surfaces this as
 *     `false`. Treated as SUCCEEDED: the goal state (message no longer in the
 *     source folder) is already true, regardless of how it got there.
 *
 *   Case B — the move was sent but the connection failed before a response came
 *     back: moveMessage() REJECTS. We cannot tell whether the server completed
 *     the move before failing. Treated as AMBIGUOUS, not blindly retried — exactly
 *     the "gerekirse ambiguous olarak Human Review'a yönlendir" instruction, not a
 *     guess dressed up as certainty. (Note for the record, not exploited
 *     automatically: a LATER attempt's own Case-A check would actually resolve
 *     this correctly on its own — but Phase 5A's idempotency policy never
 *     auto-retries an "ambiguous" execution regardless, so this isn't relied on.)
 *
 *   Connection/auth failure before any operation was attempted (can't even open
 *     the mailbox): nothing could possibly have happened yet — this is NOT
 *     ambiguous, it's a plain transient failure. Mirrors
 *     modules/mail-providers/imap/sync.ts's own treatment of connect/openMailbox
 *     errors exactly: `retryable: true`.
 *
 *   UIDVALIDITY mismatch (the mailbox's epoch changed since this email was
 *     ingested — see sync.ts's own documented handling of the same condition):
 *     the stored UID can no longer be trusted to name the same message. This is
 *     the one case genuinely safe to call permanent — `retryable: false` — since
 *     no amount of retrying fixes a UID that no longer means anything.
 */
export type { ArchiveClientFactory } from "./imapSession.js";

/**
 * Factory, not a plain object — mirrors buildProcessEmailJobHandler(clientFactory?)'s
 * exact shape: production calls createArchiveExecutor() with no argument (the
 * real ImapFlowArchiveClient is used); tests pass a fake factory.
 */
export function createArchiveExecutor(clientFactory?: ArchiveClientFactory): DestinationExecutor {
  return {
    channelType: "archive",
    execute: (ctx: ExecutionContext) => executeArchive(ctx, clientFactory),
  };
}

/** Default instance for production wiring (getExecutor in executeAction.ts). */
export const archiveExecutor: DestinationExecutor = createArchiveExecutor();

async function executeArchive(ctx: ExecutionContext, clientFactory?: ArchiveClientFactory): Promise<ExecutionOutcome> {
  const session = await openImapSession(ctx.email.mailboxConnectionId, clientFactory);
  if (!session.ok) return session.outcome;
  const { client, config } = session;
  const channelConfig = ctx.channel.config as ArchiveChannelConfig;
  const targetFolder = channelConfig.folder;

  try {
    await withTimeout(client.connect(), ARCHIVE_EXECUTOR_TIMEOUT_MS, "connect");
    const status = await withTimeout(client.openMailbox(config.folder), ARCHIVE_EXECUTOR_TIMEOUT_MS, "openMailbox");

    if (status.uidValidity !== ctx.email.uidValidity) {
      return {
        status: "failed",
        retryable: false,
        errorClass: "invalid_config",
        errorMessage: `UIDVALIDITY changed since ingestion (expected ${ctx.email.uidValidity}, mailbox is now ${status.uidValidity}) — the stored UID can no longer be trusted`,
      };
    }

    const uid = Number(ctx.email.externalId);
    // Flags first (idempotent STOREs): a failure here happens before anything
    // moved, so it falls into the plain retryable connection failure below.
    const flagsApplied = hasFlagOptions(channelConfig) ? await applyFlags(client, uid, channelConfig, ARCHIVE_EXECUTOR_TIMEOUT_MS) : false;

    let moved: ImapMoveResult | false;
    try {
      moved = await withTimeout(client.moveMessage(uid, targetFolder), ARCHIVE_EXECUTOR_TIMEOUT_MS, "moveMessage");
    } catch (moveError) {
      // Case B: sent, outcome unknown.
      return {
        status: "ambiguous",
        errorMessage: `moveMessage did not complete: ${moveError instanceof Error ? moveError.message : String(moveError)}`,
      };
    }

    // moved === false is Case A (already archived); an object is a fresh,
    // confirmed move. Both are a genuine success from Eumaeus's point of view.
    return {
      status: "succeeded",
      responseMetadata: {
        moved: moved !== false,
        targetFolder,
        sourceFolder: config.folder,
        ...(moved && moved.targetUid !== undefined ? { targetUid: moved.targetUid } : {}),
        ...(moved && moved.targetUidValidity !== undefined ? { targetUidValidity: moved.targetUidValidity } : {}),
        ...(hasFlagOptions(channelConfig) ? { flagsApplied } : {}),
      },
    };
  } catch (connectError) {
    // Nothing could have happened yet — a plain transient failure, not ambiguous.
    return {
      status: "failed",
      retryable: true,
      errorClass: "connection",
      errorMessage: connectError instanceof Error ? connectError.message : String(connectError),
    };
  } finally {
    await client.close().catch(() => {
      // Best-effort close — must not mask the real outcome above.
    });
  }
}
