import { createHmac } from "node:crypto";

/** Header carrying the HMAC signature (see webhookExecutor.ts). */
export const WEBHOOK_SIGNATURE_HEADER = "X-Jev-Signature";
/** Header carrying the deterministic idempotency identifier (§10). */
export const WEBHOOK_IDEMPOTENCY_HEADER = "X-Jev-Idempotency-Key";

/**
 * HMAC-SHA256(secret, rawRequestBody), hex-encoded — the exact bytes signed are
 * the exact bytes sent as the request body (the raw JSON string, not a
 * re-serialized/re-parsed form of it), so the receiver can verify by computing the
 * same HMAC over the raw bytes it received. Deterministic: the same body + the
 * same secret always produce the same signature: no timestamp, nonce, or random
 * salt folded in (the idempotency key header already carries the
 * replay/deduplication identity — see dispatchRoutingDecision.ts /
 * idempotency.ts).
 */
export function signWebhookBody(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}
