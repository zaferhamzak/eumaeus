import { createHash } from "node:crypto";
import type { OutboundMeta } from "../../email/outboundLog.js";
import type Mail from "nodemailer/lib/mailer/index.js";
import { prisma } from "../../../db/client.js";
import { getSenderIdentity, MailerNotConfiguredError, sendMailMessage, type SentMessageInfo } from "../../email/mailer.js";
import { FORWARD_EXECUTOR_TIMEOUT_MS } from "../idempotency.js";
import { checkDailyLimit, describeSkipped, resolveDeliverableRecipients } from "../forwardPolicy.js";
import type { ForwardChannelConfig } from "../types.js";
import { composeForward, ForwardSourceUnavailableError } from "./forwardMessage.js";
import { classifySmtpError } from "./smtpErrors.js";
import type { DestinationExecutor, ExecutionContext, ExecutionOutcome } from "./types.js";
import { toLocale } from "../../i18n/locales.js";

/** 1.2 (F): `meta` labels the send in the delivery log (sendMailMessage records it). */
export type ForwardSender = (message: Mail.Options, meta?: OutboundMeta) => Promise<SentMessageInfo>;

/**
 * Sends a copy of the email on to other addresses (Phase 13). Guardrails, all
 * re-checked here at send time because settings can change after the channel
 * was saved:
 *
 *   - never forwards a message Eumaeus itself forwarded (loop protection —
 *     the ingestion-time X-Eumaeus-Forwarded marker, see forwardHeaders.ts);
 *   - only to recipients whose owner confirmed them (ForwardRecipient
 *     "verified"), that pass the org's domain allowlist, and that aren't a
 *     mailbox this org monitors;
 *   - at most Tenant.forwardDailyLimit successful forwards per rolling 24h.
 *
 * A guardrail refusal is a permanent failure (a person has to change
 * something), so executeAction.ts escalates it to Human Review. Recipients
 * dropped by a guardrail while others remain are reported in the
 * execution's responseMetadata rather than failing the whole forward.
 */
export function createForwardExecutor(sender: ForwardSender = sendMailMessage): DestinationExecutor {
  return {
    channelType: "forward",
    execute: (ctx) => executeForward(ctx, sender),
  };
}

export const forwardExecutor: DestinationExecutor = createForwardExecutor();

async function executeForward(ctx: ExecutionContext, send: ForwardSender): Promise<ExecutionOutcome> {
  const config = ctx.channel.config as ForwardChannelConfig;

  const email = await prisma.email.findUnique({ where: { id: ctx.email.id }, include: { source: true } });
  if (!email) return permanent("invalid_config", `Email ${ctx.email.id} no longer exists`);
  if (email.forwardedByEumaeus) {
    return permanent("loop_detected", "This email is itself a copy forwarded by Eumaeus; forwarding it again could loop");
  }

  const deliverable = await resolveDeliverableRecipients(ctx.tenantId, config);
  if (deliverable.count === 0) {
    return permanent("no_deliverable_recipients", `None of this channel's recipients can receive forwards: ${describeSkipped(deliverable.skipped)}`);
  }
  const { recipients, skipped } = deliverable;

  // Phase 13.4: a digest channel only queues the email here; forwardDigest.ts
  // sends the queued emails as one message later, re-checking every guardrail.
  if (config.delivery === "digest") {
    await prisma.forwardDigestItem.upsert({
      where: { destinationChannelId_emailId: { destinationChannelId: ctx.channel.id, emailId: email.id } },
      create: { tenantId: ctx.tenantId, destinationChannelId: ctx.channel.id, emailId: email.id },
      update: {},
    });
    return { status: "succeeded", responseMetadata: { mode: config.mode, delivery: "digest", queued: true, skipped } };
  }

  const limitReached = await checkDailyLimit(ctx.tenantId);
  if (limitReached) return permanent("rate_limited", limitReached);

  let senderIdentity;
  try {
    senderIdentity = await getSenderIdentity();
  } catch (error) {
    if (error instanceof MailerNotConfiguredError) return permanent("invalid_config", "SMTP is not configured (Settings › Outbound email) — nothing can be forwarded");
    throw error;
  }

  if (email.bodyPurgedAt) return permanent("source_unavailable", "This email's content was removed by the organization's retention policy — there is nothing left to forward");

  let composed;
  try {
    composed = await composeForward({
      locale: toLocale((await prisma.tenant.findUnique({ where: { id: ctx.tenantId }, select: { locale: true } }))?.locale),
      config,
      sender: senderIdentity,
      recipients,
      email: {
        id: email.id,
        fromAddress: email.fromAddress,
        toAddresses: email.toAddresses,
        ccAddresses: email.ccAddresses,
        subject: email.subject,
        receivedAt: email.receivedAt,
        textBody: email.textBody,
        htmlBody: email.htmlBody,
        hasAttachments: email.hasAttachments,
      },
      source: email.source ? Buffer.from(email.source.source) : null,
      destinationName: ctx.routing.destinationRef,
      analysis: ctx.analysis?.signals,
      messageId: `<fwd-${createHash("sha256").update(ctx.idempotencyKey).digest("hex").slice(0, 32)}@eumaeus>`,
    });
  } catch (error) {
    if (error instanceof ForwardSourceUnavailableError) return permanent("source_unavailable", error.message);
    throw error;
  }

  let info: SentMessageInfo;
  try {
    info = await withTimeout(send(composed.message, { kind: "forward", tenantId: ctx.tenantId, relatedId: ctx.email.id }), FORWARD_EXECUTOR_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof MailerNotConfiguredError) return permanent("invalid_config", "SMTP is not configured");
    if (error instanceof SendTimeoutError) {
      return { status: "ambiguous", errorMessage: error.message };
    }
    const failure = classifySmtpError(error);
    if (failure.kind === "maybe_sent") return { status: "ambiguous", errorMessage: `SMTP send did not complete: ${failure.message}` };
    return { status: "failed", retryable: failure.kind === "not_sent_retryable", errorClass: failure.errorClass, errorMessage: failure.message };
  }

  return {
    status: "succeeded",
    responseMetadata: {
      mode: config.mode,
      recipients: [...recipients.to, ...recipients.cc, ...recipients.bcc].length,
      accepted: info.accepted,
      rejected: info.rejected,
      skipped,
      usedOriginalSource: composed.usedOriginalSource,
      messageId: info.messageId ?? null,
    },
  };
}

function permanent(errorClass: string, errorMessage: string): ExecutionOutcome {
  return { status: "failed", retryable: false, errorClass, errorMessage };
}

export class SendTimeoutError extends Error {}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new SendTimeoutError(`SMTP send did not finish within ${ms}ms — it may or may not have been delivered`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
