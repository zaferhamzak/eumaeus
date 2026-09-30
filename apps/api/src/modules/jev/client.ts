import { classifyHttpStatus, JevConnectionError, JevError, JevTimeoutError } from "./errors.js";
import type { JevQuestionDef } from "./schema.js";

/** The actual HTTP wire shape (verified docs.typesafe.ai/api.md) — a client-internal concern, not exposed by request.ts. */
interface JevWireRequestBody {
  model: string;
  state: unknown;
  questions: Record<string, JevQuestionDef>;
}

export interface JevClientConfig {
  apiKey: string;
  /** Pinned model version, e.g. "jev-1.13.0" — never "jev-latest". See config/env.ts. */
  model: string;
  /** e.g. "https://api.typesafe.ai" — the client appends "/v1/systemone" itself. */
  baseUrl: string;
  /** Total retry budget in ms for one analyze() call, including the initial attempt and all backoff delays. */
  timeoutMs: number;
  /** Injectable for tests only — defaults to the global fetch. Not a generic provider abstraction; see this module's README note in the Phase 3 report. */
  fetchImpl?: typeof fetch;
}

/**
 * Retry/backoff constants mirroring TypeSafe's own documented Python SDK defaults
 * exactly (docs.typesafe.ai/sdk/python/api/retries.md, verified 2026-09-23) rather
 * than an invented policy: initial delay 0.5s, doubling up to a 5.0s cap, 25%
 * jitter subtracted from each delay, at most 2 retries (3 attempts total).
 */
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 5000;
const JITTER_FRACTION = 0.25;
const MAX_RETRIES = 2;
/** Generous relative to Jev's documented 70-500ms typical latency; bounds one hung attempt from consuming the whole timeoutMs budget on its own. */
const PER_ATTEMPT_TIMEOUT_MS = 10_000;

export interface JevRawResponse {
  raw: unknown;
  latencyMs: number;
}

export class JevClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: JevClientConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /**
   * Calls POST {baseUrl}/v1/systemone (verified endpoint, docs.typesafe.ai/api.md)
   * with Bearer auth, retrying transient failures per the policy above and
   * respecting the overall `timeoutMs` budget. Returns the raw, not-yet-validated
   * response body — response.ts is responsible for schema validation.
   *
   * Throws a JevError subclass (see errors.ts) on any failure, with `retryable`
   * already correctly classified. Non-retryable errors are thrown immediately
   * without consuming retry attempts.
   */
  async analyze(state: unknown, questions: Record<string, JevQuestionDef>): Promise<JevRawResponse> {
    const body: JevWireRequestBody = { model: this.config.model, state, questions };
    const start = Date.now();
    let attempt = 0;
    let lastError: JevError | undefined;

    while (attempt <= MAX_RETRIES) {
      const elapsed = Date.now() - start;
      const remainingBudget = this.config.timeoutMs - elapsed;
      if (remainingBudget <= 0) {
        throw lastError ?? new JevTimeoutError("Jev request exceeded the configured timeout budget before any attempt completed");
      }

      try {
        const attemptStart = Date.now();
        const raw = await this.attemptOnce(body, Math.min(PER_ATTEMPT_TIMEOUT_MS, remainingBudget));
        return { raw, latencyMs: Date.now() - attemptStart };
      } catch (error) {
        const jevError = error instanceof JevError ? error : new JevConnectionError(String(error));
        lastError = jevError;

        if (!jevError.retryable || attempt >= MAX_RETRIES) {
          throw jevError;
        }

        const delay = computeBackoffDelay(attempt);
        const elapsedAfterFailure = Date.now() - start;
        if (elapsedAfterFailure + delay >= this.config.timeoutMs) {
          throw jevError;
        }
        await sleep(delay);
        attempt += 1;
      }
    }

    // Unreachable given the loop above always returns or throws, but keeps
    // TypeScript's control-flow analysis happy without a non-null assertion.
    throw lastError ?? new JevConnectionError("Jev request failed for an unknown reason");
  }

  private async attemptOnce(body: JevWireRequestBody, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}/v1/systemone`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new JevTimeoutError(`Jev request timed out after ${timeoutMs}ms`);
      }
      throw new JevConnectionError(`Failed to reach Jev: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "<unreadable body>");
      throw classifyHttpStatus(response.status, bodyText);
    }

    return response.json();
  }
}

function computeBackoffDelay(attempt: number): number {
  const base = Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  const jitter = base * JITTER_FRACTION * Math.random();
  return Math.round(base - jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
