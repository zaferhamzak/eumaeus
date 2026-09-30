import type Mail from "nodemailer/lib/mailer/index.js";
import { prisma } from "../../db/client.js";
import { logger } from "../../logger.js";

/**
 * 1.2 (F): the delivery log. sendMailMessage() writes one row per attempt —
 * who it went to, the subject, sent or failed (and why) — never the body.
 * Writing the log must never stop or fail a send.
 */
export const OUTBOUND_KINDS = [
  "alert",
  "review_digest",
  "assignment",
  "invite",
  "forward_verification",
  "worker",
  "smtp_test",
  "forward",
  "forward_digest",
  "auto_reply",
  "rule_notify",
  "other",
] as const;
export type OutboundKind = (typeof OUTBOUND_KINDS)[number];

export interface OutboundMeta {
  kind: OutboundKind;
  /** null / absent = a system-level email. */
  tenantId?: string | null;
  relatedId?: string | null;
}

export const OUTBOUND_RETENTION_DAYS = 90;

function addresses(value: Mail.Options["to"]): string[] {
  if (!value) return [];
  const list: unknown[] = Array.isArray(value) ? value : [value];
  return list.flatMap((a) => (typeof a === "string" ? [a] : a && typeof a === "object" && "address" in a ? [String((a as { address: unknown }).address)] : [])).filter(Boolean);
}

/** All recipients (to, cc, bcc), one string. */
export function recipientsOf(message: Mail.Options): string {
  return [...addresses(message.to), ...addresses(message.cc), ...addresses(message.bcc)].join(", ").slice(0, 1000);
}

export async function recordOutbound(message: Mail.Options, meta: OutboundMeta, outcome: { messageId?: string } | { error: unknown }): Promise<void> {
  try {
    const failed = "error" in outcome;
    const error = failed ? (outcome.error instanceof Error ? outcome.error.message : String(outcome.error)).slice(0, 500) : null;
    await prisma.outboundEmail.create({
      data: {
        tenantId: meta.tenantId ?? null,
        kind: meta.kind,
        toAddress: recipientsOf(message) || "(none)",
        subject: String(message.subject ?? "").replace(/[\r\n]+/g, " ").slice(0, 300),
        status: failed ? "failed" : "sent",
        error,
        messageId: failed ? null : (outcome.messageId ?? null),
        relatedId: meta.relatedId ?? null,
      },
    });
  } catch (err) {
    logger.warn({ event: "outbound_log_failed", err }, "could not record an outgoing email");
  }
}

/** Maintenance: rows older than the retention period go. */
export async function purgeOldOutboundEmails(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - OUTBOUND_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return (await prisma.outboundEmail.deleteMany({ where: { createdAt: { lt: cutoff } } })).count;
}
