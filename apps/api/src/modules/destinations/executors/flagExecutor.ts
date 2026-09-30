import { ARCHIVE_EXECUTOR_TIMEOUT_MS } from "../idempotency.js";
import type { FlagChannelConfig } from "../types.js";
import { applyFlags, openImapSession, withTimeout, type ArchiveClientFactory } from "./imapSession.js";
import type { DestinationExecutor, ExecutionContext, ExecutionOutcome } from "./types.js";

/**
 * Phase 15 "flag" channel: marks the message read, starred, and/or adds
 * keywords (labels on Gmail) where it is — it never moves it. Adding a flag
 * that's already there is a no-op, so a retry can't do harm; unlike a move
 * there is no ambiguous outcome to protect against, and any failure is a
 * plain retryable one.
 *
 * If the message is no longer in its folder (someone moved it by hand) the
 * flags have nothing to apply to: that's recorded as succeeded with
 * `applied: false` rather than escalated, because the instruction is moot,
 * not wrong.
 */
export function createFlagExecutor(clientFactory?: ArchiveClientFactory): DestinationExecutor {
  return {
    channelType: "flag",
    execute: (ctx) => executeFlag(ctx, clientFactory),
  };
}

export const flagExecutor: DestinationExecutor = createFlagExecutor();

async function executeFlag(ctx: ExecutionContext, clientFactory?: ArchiveClientFactory): Promise<ExecutionOutcome> {
  const session = await openImapSession(ctx.email.mailboxConnectionId, clientFactory);
  if (!session.ok) return session.outcome;
  const { client, config } = session;
  const options = ctx.channel.config as FlagChannelConfig;

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
    const applied = await applyFlags(client, Number(ctx.email.externalId), options, ARCHIVE_EXECUTOR_TIMEOUT_MS);
    return {
      status: "succeeded",
      responseMetadata: { applied, ...(applied ? {} : { reason: "message_not_in_folder" }), gmailLabels: Boolean(options.keywords?.length) && client.supportsGmailLabels() },
    };
  } catch (error) {
    return { status: "failed", retryable: true, errorClass: "connection", errorMessage: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.close().catch(() => {});
  }
}
