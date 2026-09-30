import type { ExecutionContext } from "./types.js";

/** Bumped only if this shape changes in a way a receiver would need to branch on. */
export const WEBHOOK_PAYLOAD_SCHEMA_VERSION = 1;

export interface WebhookPayload {
  schemaVersion: number;
  event: "email.routed";
  email: {
    id: string;
    externalId: string;
    subject: string;
    sender: string;
    recipients: string[];
  };
  routing: {
    destinationRef: string;
    channelType: string;
  };
  analysis?: {
    signals: Record<string, unknown>;
  };
}

/**
 * Explicitly selects a fixed, safe field set from ExecutionContext — never spreads
 * or forwards the underlying Email/AnalysisResult row. Deliberately excluded, even
 * though they exist elsewhere in the system: ccAddresses/bccAddresses, message/
 * thread ids, raw text/html body, attachment metadata, MailboxConnection details,
 * any credential/secret, and any internal database id beyond the email's own
 * (email.id — an opaque identifier, not a secret).
 *
 * Email content (subject, sender, recipients) is UNTRUSTED DATA from this
 * function's point of view, same as everywhere else in this codebase — it is
 * carried as inert JSON string/array values, never interpreted, templated, or used
 * to construct the request in any way other than as payload fields.
 */
export function buildWebhookPayload(ctx: ExecutionContext): WebhookPayload {
  const payload: WebhookPayload = {
    schemaVersion: WEBHOOK_PAYLOAD_SCHEMA_VERSION,
    event: "email.routed",
    email: {
      id: ctx.email.id,
      externalId: ctx.email.externalId,
      subject: ctx.email.subject,
      sender: ctx.email.fromAddress,
      recipients: ctx.email.toAddresses,
    },
    routing: {
      destinationRef: ctx.routing.destinationRef,
      channelType: ctx.channel.type,
    },
  };
  if (ctx.analysis) {
    payload.analysis = { signals: ctx.analysis.signals };
  }
  return payload;
}
