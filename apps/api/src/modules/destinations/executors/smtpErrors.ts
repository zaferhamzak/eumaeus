/**
 * Decides what a failed SMTP send means for idempotency — the same three-way
 * split the archive executor makes for IMAP:
 *
 *   not_sent_retryable  — nothing was handed over (connection refused, a 4xx
 *                         before or at DATA): safe to let BullMQ retry.
 *   not_sent_permanent  — the server definitively refused (5xx, bad auth):
 *                         retrying won't help, a person has to look.
 *   maybe_sent          — the connection died after the message may have been
 *                         transmitted: never retried blindly, escalated as
 *                         ambiguous so nobody receives the same mail twice.
 *
 * nodemailer errors carry `code`, `command` (the SMTP command in flight) and,
 * when the server answered, `responseCode`. An explicit server answer always
 * wins; otherwise the command in flight tells whether the message body could
 * already have gone out.
 */
export type SmtpFailureKind = "not_sent_retryable" | "not_sent_permanent" | "maybe_sent";

export interface SmtpFailure {
  kind: SmtpFailureKind;
  errorClass: string;
  message: string;
}

const PRE_DATA_COMMANDS = new Set(["CONN", "EHLO", "HELO", "LHLO", "STARTTLS", "AUTH", "AUTH PLAIN", "AUTH LOGIN", "AUTH XOAUTH2", "AUTH CRAM-MD5", "MAIL FROM", "RCPT TO"]);
/** Errors that mean no connection was ever established. */
const NEVER_CONNECTED_CODES = new Set(["EDNS", "ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"]);

export function classifySmtpError(error: unknown): SmtpFailure {
  const e = (error ?? {}) as { code?: unknown; command?: unknown; responseCode?: unknown; message?: unknown };
  const message = typeof e.message === "string" ? e.message : String(error);
  const code = typeof e.code === "string" ? e.code : undefined;
  const command = typeof e.command === "string" ? e.command.toUpperCase() : undefined;
  const responseCode = typeof e.responseCode === "number" ? e.responseCode : undefined;

  if (code === "EAUTH") return { kind: "not_sent_permanent", errorClass: "smtp_auth", message };

  if (responseCode !== undefined) {
    // The server answered. A 5xx is a definitive refusal wherever it happened;
    // a 4xx is a temporary refusal — in both cases the message was not accepted.
    if (responseCode >= 500) return { kind: "not_sent_permanent", errorClass: "smtp_rejected", message };
    if (responseCode >= 400) return { kind: "not_sent_retryable", errorClass: "smtp_temporary", message };
  }

  if (code && NEVER_CONNECTED_CODES.has(code)) return { kind: "not_sent_retryable", errorClass: "connection", message };
  if (command && (PRE_DATA_COMMANDS.has(command) || command.startsWith("AUTH"))) return { kind: "not_sent_retryable", errorClass: "connection", message };

  return { kind: "maybe_sent", errorClass: "smtp_unknown_outcome", message };
}
