import { JevClient } from "../../src/modules/jev/client.js";
import type { JevClientFactory } from "../../src/modules/jev/analyzeEmail.js";

/**
 * Fake Jev HTTP transport for tests. No test in this suite calls the real Jev API —
 * this phase's brief: "automated Jev integration tests use a deterministic
 * fake/mock; real API verification remains pending" until real credentials are
 * configured locally.
 */

export interface CapturedRequest {
  url: string;
  init: RequestInit;
  parsedBody: unknown;
}

type FetchStep = { kind: "response"; response: Response } | { kind: "throw"; error: Error };

/**
 * Returns a `typeof fetch`-compatible function that serves canned responses in
 * order, one per call, and records every call it receives (so tests can assert on
 * exactly what was sent — used by the prompt-injection test to verify the request
 * body's structure).
 */
export function createSequencedFetch(steps: FetchStep[], captured: CapturedRequest[] = []): typeof fetch {
  let index = 0;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const step = steps[index];
    index += 1;
    const bodyText = typeof init?.body === "string" ? init.body : undefined;
    captured.push({ url: String(url), init: init ?? {}, parsedBody: bodyText ? JSON.parse(bodyText) : undefined });
    if (!step) {
      throw new Error(`createSequencedFetch: ran out of configured steps (call #${index})`);
    }
    if (step.kind === "throw") throw step.error;
    return step.response;
  }) as typeof fetch;
}

export function okStep(body: unknown): FetchStep {
  return {
    kind: "response",
    response: new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  };
}

export function statusStep(status: number, text = ""): FetchStep {
  return { kind: "response", response: new Response(text, { status }) };
}

export function connectionErrorStep(message = "getaddrinfo ENOTFOUND jev.test.invalid"): FetchStep {
  return { kind: "throw", error: new Error(message) };
}

export function abortStep(): FetchStep {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return { kind: "throw", error };
}

/**
 * A structurally valid Jev response body for DECISION_SCHEMA_V1 — matches the
 * verified official response shape (docs.typesafe.ai/api.md): per-primitive answer
 * objects keyed by question id, plus model/usage. Override individual answers for
 * specific test scenarios.
 */
export function buildValidJevResponseBody(overrides?: {
  model?: string;
  answers?: Partial<Record<string, unknown>>;
}): unknown {
  return {
    model: overrides?.model ?? "jev-1.13.0",
    answers: {
      is_spam: { noul: 0.03 },
      category: {
        choice: "business_opportunity",
        probabilities: { business_opportunity: 0.82, sales: 0.09, collaboration: 0.05, other: 0.04 },
        confidence: 0.82,
      },
      is_business_opportunity: { noul: 0.88 },
      is_collaboration: { noul: 0.06 },
      is_customer_related: { noul: 0.12 },
      requires_response: { noul: 0.79 },
      // Real shape (verified against docs.typesafe.ai/primitives/score.md and a
      // real Jev call during Phase 3 verification): `score` is a continuous
      // weighted mean over level indices, `legend`/`probabilities` are keyed by
      // index-as-string, not by level name. legend: 0=low, 1=medium, 2=high, 3=critical.
      urgency: {
        score: 1.15,
        legend: { "0": "low", "1": "medium", "2": "high", "3": "critical" },
        probabilities: { "0": 0.1, "1": 0.7, "2": 0.15, "3": 0.05 },
        confidence: 0.7,
      },
      human_review_required: { noul: 0.04 },
      ...overrides?.answers,
    },
    usage: { input_tokens: 184, output_tokens: 0 },
  };
}

/** Builds a JevClientFactory (the shape analyzeEmail()/the worker expect) backed by a fake fetch implementation. */
export function fakeClientFactory(fetchImpl: typeof fetch, timeoutMs = 5000): JevClientFactory {
  return () => new JevClient({ apiKey: "test-key", model: "jev-1.13.0", baseUrl: "https://jev.test.invalid", timeoutMs, fetchImpl });
}

/** A fetch implementation that fails the test if it is ever invoked — used to prove idempotency (Jev must not be called again). */
export function fetchThatMustNotBeCalled(): typeof fetch {
  return (async () => {
    throw new Error("fetch was called, but this test asserts it must not be — idempotency check failed to short-circuit");
  }) as typeof fetch;
}
