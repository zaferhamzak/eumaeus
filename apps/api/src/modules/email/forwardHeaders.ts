/**
 * Stamped on every message the forward executor sends. Ingestion
 * (mail-providers/imap/parse.ts) looks for it and marks the Email
 * `forwardedByEumaeus`, and the forward executor refuses to forward such an
 * email again — so a forward into another monitored mailbox can never loop.
 * The value is informational only (never trusted for anything): the presence
 * of the header is the signal.
 */
export const FORWARDED_HEADER = "X-Eumaeus-Forwarded";
/** Stamped before the product was renamed — copies carrying it are still ours. */
export const LEGACY_FORWARDED_HEADER = "X-JevMail-Forwarded";
