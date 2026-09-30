import { describe, expect, it } from "vitest";
import { classifyWebhookResponse } from "../../src/modules/destinations/executors/webhookExecutor.js";

describe("classifyWebhookResponse — the documented response-code matrix", () => {
  it.each([200, 201, 204, 299])("status %d succeeds", (code) => {
    expect(classifyWebhookResponse(code)).toMatchObject({ status: "succeeded" });
  });

  it.each([408, 429, 500, 502, 503, 504])("status %d is a retryable failure", (code) => {
    expect(classifyWebhookResponse(code)).toMatchObject({ status: "failed", retryable: true });
  });

  it.each([400, 401, 403, 404, 409, 410, 422])("status %d (a 4xx not in the retryable list) is a permanent failure", (code) => {
    expect(classifyWebhookResponse(code)).toMatchObject({ status: "failed", retryable: false });
  });

  it("an unrecognized/unexpected status code defaults to retryable — never a silent success or a silent permanent give-up", () => {
    expect(classifyWebhookResponse(501)).toMatchObject({ status: "failed", retryable: true });
    expect(classifyWebhookResponse(305)).toMatchObject({ status: "failed", retryable: true });
    expect(classifyWebhookResponse(100)).toMatchObject({ status: "failed", retryable: true });
  });
});
