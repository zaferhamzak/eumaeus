import { prisma } from "../../db/client.js";
import { recordAuditEvent, AuditEventType } from "../audit/record.js";
import { escalateToHumanReview } from "../review/escalate.js";
import { getSenderIdentity, isMailerConfigured, sendMailMessage } from "../email/mailer.js";
import { logger } from "../../logger.js";
import { FORWARD_EXECUTOR_TIMEOUT_MS } from "./idempotency.js";
import { checkDailyLimit, describeSkipped, resolveDeliverableRecipients } from "./forwardPolicy.js";
import { composeDigest } from "./executors/forwardDigestMessage.js";
import { SendTimeoutError, withTimeout, type ForwardSender } from "./executors/forwardExecutor.js";
import { classifySmtpError } from "./executors/smtpErrors.js";
import { DEFAULT_DIGEST_INTERVAL_MINUTES, type ForwardChannelConfig } from "./types.js";
import { toLocale } from "../i18n/locales.js";

/**
 * Sends forward digests (Phase 13.4). Run every few minutes by the
 * forward-digest queue. For each channel with queued emails whose interval
 * has passed: claim up to MAX_ITEMS_PER_DIGEST of them into a "sending"
 * batch, re-check every guardrail, send one message, then settle:
 *
 *   sent                  — items stay attached to the batch; audited per email.
 *   not sent, retryable   — items go back to the queue for the next run.
 *   not sent, permanent   — batch failed; each email goes to Human Review.
 *   maybe sent            — batch ambiguous; each email goes to Human Review,
 *                           never resent (nobody gets the same digest twice).
 *
 * A batch still "sending" long after the send timeout means the worker died
 * mid-send: resolved as ambiguous on the next run.
 */
export const MAX_ITEMS_PER_DIGEST = 50;
const MAX_BATCHES_PER_CHANNEL_PER_RUN = 20;
const STALE_SENDING_MS = FORWARD_EXECUTOR_TIMEOUT_MS * 3;

export interface ChannelDigestResult {
  destinationChannelId: string;
  outcome: "not_due" | "sent" | "cancelled" | "smtp_not_configured" | "retry_later" | "failed" | "ambiguous";
  batchesSent: number;
  emailsSent: number;
}

export async function runForwardDigests(now: Date = new Date(), send: ForwardSender = sendMailMessage): Promise<ChannelDigestResult[]> {
  await resolveStaleBatches(now);

  const channels = await prisma.forwardDigestItem.groupBy({ by: ["destinationChannelId"], where: { status: "queued" } });
  const results: ChannelDigestResult[] = [];
  for (const { destinationChannelId } of channels) {
    try {
      results.push(await runChannel(destinationChannelId, now, send));
    } catch (error) {
      logger.error({ event: "forward_digest_channel_failed", err: error, destinationChannelId }, "forward digest run failed for a channel");
    }
  }
  return results;
}

async function runChannel(destinationChannelId: string, now: Date, send: ForwardSender): Promise<ChannelDigestResult> {
  const result: ChannelDigestResult = { destinationChannelId, outcome: "not_due", batchesSent: 0, emailsSent: 0 };
  const channel = await prisma.destinationChannel.findUnique({ where: { id: destinationChannelId }, include: { destination: { select: { name: true } } } });

  // Disabled (edits carry queued items over to the new version, so a
  // deactivated channel here was switched off on purpose).
  if (!channel || !channel.enabled || channel.deactivatedAt) {
    const queued = await prisma.forwardDigestItem.findMany({ where: { destinationChannelId, status: "queued" }, select: { id: true, tenantId: true, emailId: true } });
    await prisma.forwardDigestItem.updateMany({ where: { id: { in: queued.map((q) => q.id) }, status: "queued" }, data: { status: "cancelled" } });
    for (const item of queued) {
      await recordAuditEvent(prisma, {
        tenantId: item.tenantId,
        emailId: item.emailId,
        eventType: AuditEventType.FORWARD_DIGEST_CANCELLED,
        actor: "system",
        payload: { destinationChannelId, reason: "channel_disabled" },
      });
    }
    return { ...result, outcome: "cancelled" };
  }

  const config = channel.config as unknown as ForwardChannelConfig;
  if (!(await isDue(destinationChannelId, config, now))) return result;
  if (!(await isMailerConfigured())) return { ...result, outcome: "smtp_not_configured" };

  for (let i = 0; i < MAX_BATCHES_PER_CHANNEL_PER_RUN; i += 1) {
    const outcome = await sendOneBatch(channel.tenantId, destinationChannelId, channel.destination.name, config, send, now);
    if (outcome === "empty") break;
    if (outcome.kind !== "sent") return { ...result, outcome: outcome.kind };
    result.outcome = "sent";
    result.batchesSent += 1;
    result.emailsSent += outcome.emails;
  }
  return result;
}

/** A channel switched from digest back to "each" flushes its queue right away. */
async function isDue(destinationChannelId: string, config: ForwardChannelConfig, now: Date): Promise<boolean> {
  if (config.delivery !== "digest") return true;
  const intervalMs = (config.digestIntervalMinutes ?? DEFAULT_DIGEST_INTERVAL_MINUTES) * 60_000;
  const lastBatch = await prisma.forwardDigestBatch.findFirst({ where: { destinationChannelId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  const since =
    lastBatch?.createdAt ??
    (await prisma.forwardDigestItem.findFirst({ where: { destinationChannelId, status: "queued" }, orderBy: { queuedAt: "asc" }, select: { queuedAt: true } }))?.queuedAt;
  return since !== undefined && now.getTime() - since.getTime() >= intervalMs;
}

type BatchOutcome = "empty" | { kind: "sent"; emails: number } | { kind: "retry_later" | "failed" | "ambiguous" };

async function sendOneBatch(
  tenantId: string,
  destinationChannelId: string,
  destinationName: string,
  config: ForwardChannelConfig,
  send: ForwardSender,
  now: Date,
): Promise<BatchOutcome> {
  const batch = await prisma.$transaction(async (tx) => {
    const items = await tx.forwardDigestItem.findMany({ where: { destinationChannelId, status: "queued" }, orderBy: { queuedAt: "asc" }, take: MAX_ITEMS_PER_DIGEST, select: { id: true } });
    if (items.length === 0) return null;
    const created = await tx.forwardDigestBatch.create({ data: { tenantId, destinationChannelId, status: "sending", itemCount: items.length, createdAt: now } });
    await tx.forwardDigestItem.updateMany({ where: { id: { in: items.map((i) => i.id) }, status: "queued" }, data: { status: "batched", batchId: created.id } });
    return created;
  });
  if (!batch) return "empty";

  const items = await prisma.forwardDigestItem.findMany({
    where: { batchId: batch.id },
    orderBy: { queuedAt: "asc" },
    include: { email: { include: { source: true } } },
  });
  const emailIds = items.map((i) => i.emailId);

  const deliverable = await resolveDeliverableRecipients(tenantId, config);
  if (deliverable.count === 0) {
    await failBatch(batch.id, tenantId, emailIds, "failed", "no_deliverable_recipients", `None of this channel's recipients can receive forwards: ${describeSkipped(deliverable.skipped)}`);
    return { kind: "failed" };
  }
  const limitReached = await checkDailyLimit(tenantId);
  if (limitReached) {
    await failBatch(batch.id, tenantId, emailIds, "failed", "rate_limited", limitReached);
    return { kind: "failed" };
  }

  const analyses = await prisma.analysisResult.findMany({ where: { emailId: { in: emailIds } }, orderBy: { createdAt: "asc" }, select: { emailId: true, answers: true } });
  const analysisByEmail = new Map(analyses.map((a) => [a.emailId, a.answers as Record<string, unknown> | null]));

  const composed = composeDigest({
    locale: toLocale((await prisma.tenant.findUnique({ where: { id: tenantId }, select: { locale: true } }))?.locale),
    config,
    sender: await getSenderIdentity(),
    recipients: deliverable.recipients,
    destinationName,
    batchId: batch.id,
    emails: items.map(({ email }) => ({
      id: email.id,
      fromAddress: email.fromAddress,
      subject: email.subject,
      receivedAt: email.receivedAt,
      textBody: email.textBody,
      source: email.source ? Buffer.from(email.source.source) : null,
      analysis: analysisByEmail.get(email.id) ?? undefined,
    })),
  });

  try {
    const info = await withTimeout(send(composed.message, { kind: "forward_digest", tenantId, relatedId: batch.id }), FORWARD_EXECUTOR_TIMEOUT_MS);
    await prisma.forwardDigestBatch.update({ where: { id: batch.id }, data: { status: "sent", completedAt: new Date(), messageId: info.messageId ?? null } });
    for (const emailId of emailIds) {
      await recordAuditEvent(prisma, {
        tenantId,
        emailId,
        eventType: AuditEventType.FORWARD_DIGEST_SENT,
        actor: "system",
        payload: { batchId: batch.id, destinationChannelId, emails: emailIds.length, recipients: deliverable.count, skipped: deliverable.skipped },
      });
    }
    return { kind: "sent", emails: emailIds.length };
  } catch (error) {
    if (error instanceof SendTimeoutError) {
      await failBatch(batch.id, tenantId, emailIds, "ambiguous", "smtp_unknown_outcome", error.message);
      return { kind: "ambiguous" };
    }
    const failure = classifySmtpError(error);
    if (failure.kind === "not_sent_retryable") {
      // Nothing was handed over: put the emails back for the next run.
      await prisma.$transaction([
        prisma.forwardDigestBatch.update({ where: { id: batch.id }, data: { status: "failed", completedAt: new Date(), errorClass: failure.errorClass, errorMessage: failure.message } }),
        prisma.forwardDigestItem.updateMany({ where: { batchId: batch.id }, data: { status: "queued", batchId: null } }),
      ]);
      return { kind: "retry_later" };
    }
    const status = failure.kind === "maybe_sent" ? "ambiguous" : "failed";
    await failBatch(batch.id, tenantId, emailIds, status, failure.errorClass, failure.message);
    return { kind: status };
  }
}

async function failBatch(batchId: string, tenantId: string, emailIds: string[], status: "failed" | "ambiguous", errorClass: string, errorMessage: string): Promise<void> {
  await prisma.forwardDigestBatch.update({ where: { id: batchId }, data: { status, errorClass, errorMessage, completedAt: new Date() } });
  for (const emailId of emailIds) {
    await escalateToHumanReview(tenantId, emailId, {
      errorMessage: `Forward digest ${status === "ambiguous" ? "may or may not have been sent" : "could not be sent"}: ${errorMessage}`,
      attemptsMade: 0,
      reason: status === "ambiguous" ? "execution_ambiguous" : "execution_failed",
    });
  }
}

async function resolveStaleBatches(now: Date): Promise<void> {
  const stale = await prisma.forwardDigestBatch.findMany({
    where: { status: "sending", createdAt: { lt: new Date(now.getTime() - STALE_SENDING_MS) } },
    include: { items: { select: { emailId: true } } },
  });
  for (const batch of stale) {
    const claimed = await prisma.forwardDigestBatch.updateMany({ where: { id: batch.id, status: "sending" }, data: { status: "ambiguous", completedAt: now, errorClass: "stale_sending", errorMessage: "The worker stopped while this digest was being sent" } });
    if (claimed.count === 0) continue;
    for (const { emailId } of batch.items) {
      await escalateToHumanReview(batch.tenantId, emailId, {
        errorMessage: "A forward digest containing this email may or may not have been sent (the worker stopped mid-send)",
        attemptsMade: 0,
        reason: "execution_ambiguous",
      });
    }
  }
}
