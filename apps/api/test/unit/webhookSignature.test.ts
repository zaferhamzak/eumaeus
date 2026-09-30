import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signWebhookBody } from "../../src/modules/destinations/executors/webhookSignature.js";

describe("signWebhookBody — HMAC-SHA256(secret, rawBody)", () => {
  it("matches a manually-computed HMAC-SHA256 hex digest", () => {
    const secret = "my-signing-secret";
    const body = '{"hello":"world"}';
    const expected = createHmac("sha256", secret).update(body, "utf8").digest("hex");

    expect(signWebhookBody(secret, body)).toBe(expected);
  });

  it("is deterministic — the same secret and body always produce the same signature", () => {
    const a = signWebhookBody("secret", "body");
    const b = signWebhookBody("secret", "body");
    expect(a).toBe(b);
  });

  it("a different body produces a different signature", () => {
    const a = signWebhookBody("secret", "body-one");
    const b = signWebhookBody("secret", "body-two");
    expect(a).not.toBe(b);
  });

  it("a different secret produces a different signature for the same body", () => {
    const a = signWebhookBody("secret-one", "same-body");
    const b = signWebhookBody("secret-two", "same-body");
    expect(a).not.toBe(b);
  });

  it("the secret itself never appears in the output signature", () => {
    const secret = "very-recognizable-secret-value";
    const signature = signWebhookBody(secret, "some body");
    expect(signature).not.toContain(secret);
  });
});
