import { describe, expect, it } from "vitest";
import { computeIdempotencyKey } from "../../src/modules/destinations/idempotency.js";

describe("computeIdempotencyKey", () => {
  it("is deterministic — the same inputs always produce the same key", () => {
    const a = computeIdempotencyKey("email-1", "decision-1", "channel-1");
    const b = computeIdempotencyKey("email-1", "decision-1", "channel-1");
    expect(a).toBe(b);
  });

  it("differs if any one component differs", () => {
    const base = computeIdempotencyKey("email-1", "decision-1", "channel-1");
    expect(computeIdempotencyKey("email-2", "decision-1", "channel-1")).not.toBe(base);
    expect(computeIdempotencyKey("email-1", "decision-2", "channel-1")).not.toBe(base);
    expect(computeIdempotencyKey("email-1", "decision-1", "channel-2")).not.toBe(base);
  });
});
