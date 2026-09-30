/**
 * Error classification for the Jev client.
 *
 * Every error the client can throw carries a `retryable` flag, computed HERE (the
 * one place that knows the official retry/error semantics), so callers (the
 * process-email worker) never have to re-derive "should I retry this?" themselves —
 * implementation-plan.md §I: "The Jev client should classify errors correctly so
 * the worker can make the right decision."
 *
 * Classification is based on docs.typesafe.ai/api.md (HTTP codes) and
 * docs.typesafe.ai/sdk/python/api/retries.md (which codes the official SDK retries
 * by default), both re-verified 2026-09-23:
 *   - 401 (bad/missing API key)        -> permanent  (authentication)
 *   - 422 (request validation failure) -> permanent  (validation)
 *   - 429 (rate limited)               -> retryable  (rate_limit)
 *   - 408, 5xx (incl. 529 "overloaded") -> retryable  (timeout / server)
 *   - network/connection failure        -> retryable  (connection)
 *   - our own per-attempt abort/timeout -> retryable  (timeout)
 *   - a 200 response that fails our schema validation -> permanent
 *     (malformed_response) — a deterministic request that produced an
 *     unparseable shape will almost certainly produce the same shape again;
 *     retrying is very unlikely to help and would just burn the retry budget.
 *   - any other/unexpected HTTP status -> permanent by default (unexpected_status)
 *     — safer to surface an unfamiliar failure than to retry it blindly.
 */
export type JevErrorClass =
  | "authentication"
  | "validation"
  | "rate_limit"
  | "server"
  | "timeout"
  | "connection"
  | "malformed_response"
  | "unexpected_status";

export abstract class JevError extends Error {
  abstract readonly errorClass: JevErrorClass;
  abstract readonly retryable: boolean;
}

export class JevAuthenticationError extends JevError {
  readonly errorClass = "authentication" as const;
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = "JevAuthenticationError";
  }
}

export class JevValidationError extends JevError {
  readonly errorClass = "validation" as const;
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = "JevValidationError";
  }
}

export class JevRateLimitError extends JevError {
  readonly errorClass = "rate_limit" as const;
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "JevRateLimitError";
  }
}

export class JevServerError extends JevError {
  readonly errorClass = "server" as const;
  readonly retryable = true;
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "JevServerError";
  }
}

export class JevTimeoutError extends JevError {
  readonly errorClass = "timeout" as const;
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "JevTimeoutError";
  }
}

export class JevConnectionError extends JevError {
  readonly errorClass = "connection" as const;
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "JevConnectionError";
  }
}

export class JevMalformedResponseError extends JevError {
  readonly errorClass = "malformed_response" as const;
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = "JevMalformedResponseError";
  }
}

export class JevUnexpectedStatusError extends JevError {
  readonly errorClass = "unexpected_status" as const;
  readonly retryable = false;
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "JevUnexpectedStatusError";
  }
}

/** Maps an HTTP status code from the Jev API to the correct error, per the classification above. */
export function classifyHttpStatus(status: number, bodyText: string): JevError {
  if (status === 401) return new JevAuthenticationError(`Jev authentication failed (401): ${bodyText}`);
  if (status === 422) return new JevValidationError(`Jev rejected the request (422): ${bodyText}`);
  if (status === 429) return new JevRateLimitError(`Jev rate limit exceeded (429): ${bodyText}`);
  if (status === 408) return new JevTimeoutError(`Jev reported a request timeout (408): ${bodyText}`);
  if (status >= 500 && status <= 599) return new JevServerError(`Jev server error (${status}): ${bodyText}`, status);
  return new JevUnexpectedStatusError(`Unexpected Jev HTTP status ${status}: ${bodyText}`, status);
}
