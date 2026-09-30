import { describe, expect, it } from "vitest";
import { JevClient } from "../../src/modules/jev/client.js";
import {
  JevAuthenticationError,
  JevConnectionError,
  JevRateLimitError,
  JevServerError,
  JevTimeoutError,
  JevValidationError,
} from "../../src/modules/jev/errors.js";
import { abortStep, buildValidJevResponseBody, connectionErrorStep, createSequencedFetch, okStep, statusStep } from "../fixtures/jevFixtures.js";

function makeClient(fetchImpl: typeof fetch, timeoutMs = 30_000) {
  return new JevClient({ apiKey: "test-key", model: "jev-1.13.0", baseUrl: "https://jev.test.invalid", timeoutMs, fetchImpl });
}

describe("JevClient — HTTP call, retry policy, error classification", () => {
  it("sends the pinned model, Bearer auth, and JSON content-type on a successful call", async () => {
    const captured: import("../fixtures/jevFixtures.js").CapturedRequest[] = [];
    const fetchImpl = createSequencedFetch([okStep(buildValidJevResponseBody())], captured);
    const client = makeClient(fetchImpl);

    const result = await client.analyze({ subject: "hi" }, {});

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("https://jev.test.invalid/v1/systemone");
    expect((captured[0]?.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer test-key");
    expect((captured[0]?.parsedBody as { model: string }).model).toBe("jev-1.13.0");
    expect(result.raw).toBeDefined();
  });

  it("retries on 429 and succeeds on the next attempt", async () => {
    const fetchImpl = createSequencedFetch([statusStep(429, "rate limited"), okStep(buildValidJevResponseBody())]);
    const client = makeClient(fetchImpl);

    const result = await client.analyze({}, {});
    expect(result.raw).toBeDefined();
  });

  it("retries on a 5xx server error (including the documented 529 'overloaded' code)", async () => {
    const fetchImpl = createSequencedFetch([statusStep(529, "overloaded"), okStep(buildValidJevResponseBody())]);
    const client = makeClient(fetchImpl);

    const result = await client.analyze({}, {});
    expect(result.raw).toBeDefined();
  });

  it("retries on a connection failure", async () => {
    const fetchImpl = createSequencedFetch([connectionErrorStep(), okStep(buildValidJevResponseBody())]);
    const client = makeClient(fetchImpl);

    const result = await client.analyze({}, {});
    expect(result.raw).toBeDefined();
  });

  it("retries on an aborted/timed-out attempt", async () => {
    const fetchImpl = createSequencedFetch([abortStep(), okStep(buildValidJevResponseBody())]);
    const client = makeClient(fetchImpl);

    const result = await client.analyze({}, {});
    expect(result.raw).toBeDefined();
  });

  it("does NOT retry a 401 — throws JevAuthenticationError immediately", async () => {
    const fetchImpl = createSequencedFetch([statusStep(401, "bad key")]); // only one step configured on purpose
    const client = makeClient(fetchImpl);

    await expect(client.analyze({}, {})).rejects.toBeInstanceOf(JevAuthenticationError);
  });

  it("does NOT retry a 422 — throws JevValidationError immediately", async () => {
    const fetchImpl = createSequencedFetch([statusStep(422, "bad request")]);
    const client = makeClient(fetchImpl);

    await expect(client.analyze({}, {})).rejects.toBeInstanceOf(JevValidationError);
  });

  it("gives up after exhausting retries on repeated 429s and throws JevRateLimitError", async () => {
    // 3 total attempts allowed (1 initial + 2 retries); a 4th configured step would
    // never be reached if the client is correctly capped.
    const fetchImpl = createSequencedFetch([statusStep(429), statusStep(429), statusStep(429)]);
    const client = makeClient(fetchImpl);

    await expect(client.analyze({}, {})).rejects.toBeInstanceOf(JevRateLimitError);
  });

  it("throws JevServerError for an unretried-away 5xx after exhaustion", async () => {
    const fetchImpl = createSequencedFetch([statusStep(500), statusStep(500), statusStep(500)]);
    const client = makeClient(fetchImpl);

    await expect(client.analyze({}, {})).rejects.toBeInstanceOf(JevServerError);
  });

  it("stops retrying once the total timeout budget would be exceeded", async () => {
    // A tiny budget means even the first backoff delay can't fit — the client
    // must fail fast rather than sleep past its own configured budget.
    const fetchImpl = createSequencedFetch([statusStep(429), statusStep(429), statusStep(429)]);
    const client = makeClient(fetchImpl, 50);

    await expect(client.analyze({}, {})).rejects.toBeInstanceOf(JevRateLimitError);
  });

  it("classifies an unexpected/undocumented HTTP status as non-retryable", async () => {
    const fetchImpl = createSequencedFetch([statusStep(418, "teapot")]);
    const client = makeClient(fetchImpl);

    await expect(client.analyze({}, {})).rejects.toThrow(/Unexpected Jev HTTP status 418/);
  });

  it("wraps a raw thrown non-Jev error as a retryable JevConnectionError", async () => {
    const fetchImpl = createSequencedFetch([connectionErrorStep("ECONNRESET"), connectionErrorStep("ECONNRESET"), connectionErrorStep("ECONNRESET")]);
    const client = makeClient(fetchImpl);

    await expect(client.analyze({}, {})).rejects.toBeInstanceOf(JevConnectionError);
  });

  it("classifies an abort as JevTimeoutError", async () => {
    const fetchImpl = createSequencedFetch([abortStep(), abortStep(), abortStep()]);
    const client = makeClient(fetchImpl);

    await expect(client.analyze({}, {})).rejects.toBeInstanceOf(JevTimeoutError);
  });
});
