import { createHash } from "node:crypto";
import { prisma } from "../../../db/client.js";
import { getSenderIdentity, MailerNotConfiguredError, sendMailMessage } from "../../email/mailer.js";
import { FORWARDED_HEADER } from "../../email/forwardHeaders.js";
import { FORWARD_EXECUTOR_TIMEOUT_MS } from "../idempotency.js";
import { checkDailyLimit } from "../forwardPolicy.js";
import { monitoredAddresses } from "../manageDestinations.js";
import {
  DEFAULT_AUTO_REPLY_COOLDOWN_DAYS,
  DEFAULT_AUTO_REPLY_MAX_SPAM,
  DEFAULT_AUTO_REPLY_SUBJECT,
  type AutoReplyChannelConfig,
} from "../types.js";
import { SendTimeoutError, withTimeout, type ForwardSender } from "./forwardExecutor.js";
import { classifySmtpError } from "./smtpErrors.js";
import type { DestinationExecutor, ExecutionContext, ExecutionOutcome } from "./types.js";

/**
 * Answers the sender with a fixed message (Phase 19). An auto-responder that
 * answers the wrong mail is worse than none, so it stays silent — recorded as
 * succeeded with `sent: false` and the reason, never escalated — whenever:
 *
 *   - the email is automated (RFC 3834): Auto-Submitted other than "no",
 *     Precedence bulk/list/junk, a List-Id, or a no-reply style address;
 *   - its headers weren't captured (ingested before 0.19), so the above
 *     can't be checked;
 *   - Jev scored it as likely spam (maxSpamScore), or it has no analysis;
 *   - the sender was answered by this destination within cooldownDays;
 *   - it came from Eumaeus itself, or from a mailbox the organization watches.
 *
 * The reply carries Auto-Submitted: auto-replied (so well-behaved
 * responders don't answer it) and Eumaeus's own loop marker. Replies count
 * toward the organization's daily outgoing-mail limit, together with forwards.
 */
export const NO_REPLY_LOCAL_PART = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|bounces?)([+._-].*)?$/i;

export type AutoReplySkip = "headers_unknown" | "automated" | "mailing_list" | "no_reply_address" | "no_analysis" | "likely_spam" | "cooldown" | "own_mail";

export function createAutoReplyExecutor(sender: ForwardSender = sendMailMessage): DestinationExecutor {
  return { channelType: "auto_reply", execute: (ctx) => executeAutoReply(ctx, sender) };
}

export const autoReplyExecutor: DestinationExecutor = createAutoReplyExecutor();

const DAY_MS = 24 * 60 * 60 * 1000;

function skip(reason: AutoReplySkip, detail?: string): ExecutionOutcome {
  return { status: "succeeded", responseMetadata: { sent: false, skipped: reason, ...(detail ? { detail } : {}) } };
}

function render(template: string, values: Record<string, string>): string {
  return template.replace(/\{(subject|sender|sender_name|category)\}/g, (_, k: string) => values[k] ?? "");
}

async function executeAutoReply(ctx: ExecutionContext, send: ForwardSender): Promise<ExecutionOutcome> {
  const config = ctx.channel.config as AutoReplyChannelConfig;
  const email = await prisma.email.findUnique({ where: { id: ctx.email.id } });
  if (!email) return { status: "failed", retryable: false, errorClass: "invalid_config", errorMessage: `Email ${ctx.email.id} no longer exists` };

  if (email.forwardedByEumaeus) return skip("own_mail");
  if (!email.headersCaptured) return skip("headers_unknown", "received before auto-replies could check its headers");
  if (email.autoSubmitted && email.autoSubmitted.toLowerCase() !== "no") return skip("automated", `Auto-Submitted: ${email.autoSubmitted}`);
  if (email.precedence && /^(bulk|list|junk)$/i.test(email.precedence)) return skip("automated", `Precedence: ${email.precedence}`);
  if (email.listId) return skip("mailing_list");

  const recipient = (email.replyToAddress ?? email.fromAddress).trim().toLowerCase();
  if (NO_REPLY_LOCAL_PART.test(recipient.split("@")[0] ?? "") || NO_REPLY_LOCAL_PART.test(email.fromAddress.split("@")[0] ?? "")) return skip("no_reply_address");

  const spam = (ctx.analysis?.signals.is_spam as { noul?: unknown } | undefined)?.noul;
  if (typeof spam !== "number") return skip("no_analysis");
  if (spam >= (config.maxSpamScore ?? DEFAULT_AUTO_REPLY_MAX_SPAM)) return skip("likely_spam", `spam score ${spam.toFixed(2)}`);

  let senderIdentity;
  try {
    senderIdentity = await getSenderIdentity();
  } catch (error) {
    if (error instanceof MailerNotConfiguredError) return { status: "failed", retryable: false, errorClass: "invalid_config", errorMessage: "SMTP is not configured (Settings › Outbound email) — no reply can be sent" };
    throw error;
  }
  if (recipient === senderIdentity.address.toLowerCase() || (await monitoredAddresses(ctx.tenantId)).has(recipient)) return skip("own_mail");

  const cooldownMs = (config.cooldownDays ?? DEFAULT_AUTO_REPLY_COOLDOWN_DAYS) * DAY_MS;
  const last = await prisma.autoReplyRecord.findUnique({ where: { tenantId_destinationId_recipient: { tenantId: ctx.tenantId, destinationId: ctx.channel.destinationId, recipient } } });
  if (last && Date.now() - last.lastSentAt.getTime() < cooldownMs) return skip("cooldown", `last reply ${last.lastSentAt.toISOString()}`);

  const limitReached = await checkDailyLimit(ctx.tenantId);
  if (limitReached) return { status: "failed", retryable: false, errorClass: "rate_limited", errorMessage: limitReached };

  const category = (ctx.analysis?.signals.category as { choice?: unknown } | undefined)?.choice;
  const values = {
    subject: (email.subject ?? "").replace(/[\r\n]+/g, " "),
    sender: email.fromAddress,
    sender_name: email.senderName ?? email.fromAddress.split("@")[0] ?? "",
    category: typeof category === "string" ? category : "",
  };
  const text = render(config.body, values);
  const html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");

  try {
    const info = await withTimeout(
      send({
        from: { name: config.fromName ?? senderIdentity.name, address: senderIdentity.address },
        to: recipient,
        subject: render(config.subjectTemplate ?? DEFAULT_AUTO_REPLY_SUBJECT, values).replace(/[\r\n]+/g, " ").slice(0, 250),
        text,
        html,
        messageId: `<reply-${createHash("sha256").update(ctx.idempotencyKey).digest("hex").slice(0, 32)}@eumaeus>`,
        ...(email.messageId ? { inReplyTo: email.messageId, references: email.messageId } : {}),
        headers: { "Auto-Submitted": "auto-replied", [FORWARDED_HEADER]: `reply:${email.id}` },
      }, { kind: "auto_reply", tenantId: ctx.tenantId, relatedId: email.id }),
      FORWARD_EXECUTOR_TIMEOUT_MS,
    );
    await prisma.autoReplyRecord.upsert({
      where: { tenantId_destinationId_recipient: { tenantId: ctx.tenantId, destinationId: ctx.channel.destinationId, recipient } },
      create: { tenantId: ctx.tenantId, destinationId: ctx.channel.destinationId, recipient, lastSentAt: new Date() },
      update: { lastSentAt: new Date() },
    });
    return { status: "succeeded", responseMetadata: { sent: true, recipient, messageId: info.messageId ?? null } };
  } catch (error) {
    if (error instanceof SendTimeoutError) return { status: "ambiguous", errorMessage: error.message };
    const failure = classifySmtpError(error);
    if (failure.kind === "maybe_sent") return { status: "ambiguous", errorMessage: `SMTP send did not complete: ${failure.message}` };
    return { status: "failed", retryable: failure.kind === "not_sent_retryable", errorClass: failure.errorClass, errorMessage: failure.message };
  }
}
