import { beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createWebhookExecutor } from "../../src/modules/destinations/executors/webhookExecutor.js";
import { WebhookConnectionError, WebhookResponseLostError, type WebhookHttpResult } from "../../src/modules/destinations/executors/webhookHttpClient.js";
import { WEBHOOK_SIGNATURE_HEADER, WEBHOOK_IDEMPOTENCY_HEADER } from "../../src/modules/destinations/executors/webhookSignature.js";
import { setDestinationSecret } from "../../src/modules/destinations/manageSecrets.js";
import type { ExecutionContext } from "../../src/modules/destinations/executors/types.js";
import type { WebhookChannelConfig } from "../../src/modules/destinations/types.js";
import { createReceivedEmail, createTestTenantAndMailbox, createWebhookDestination, resetDatabase } from "../helpers/db.js";

const PUBLIC_IP = "93.184.216.34";
const fakeDns = () => Promise.resolve([{ address: PUBLIC_IP, family: 4 }]);

async function ctxFor(url: string, secretName?: string) {
  const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
  const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1", {
    subject: "Quarterly proposal",
    fromAddress: "alice@example.com",
  });
  const { destination, channel } = await createWebhookDestination(tenant.id, "webhook-dest", url, secretName);

  const ctx: ExecutionContext = {
    tenantId: tenant.id,
    email: {
      id: email.id,
      mailboxConnectionId: mailboxConnection.id,
      externalId: email.externalId,
      uidValidity: email.uidValidity,
      subject: email.subject ?? "",
      fromAddress: email.fromAddress,
      toAddresses: email.toAddresses,
    },
    routing: { destinationRef: destination.name },
    analysis: { signals: { is_spam: { noul: 0.02 }, category: { choice: "business_opportunity" } } },
    channel: { id: channel.id, type: "webhook", config: channel.config as unknown as WebhookChannelConfig, destinationId: destination.id },
    idempotencyKey: "email-1:decision-1:channel-1",
  };
  return { ctx, tenant, destination, email };
}

describe("webhookExecutor — payload, signing, SSRF integration, response handling", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("a 2xx response succeeds, with the status code recorded in responseMetadata", async () => {
    const { ctx } = await ctxFor("https://hooks.example.com/incoming");
    const executor = createWebhookExecutor({
      dnsLookup: fakeDns,
      performRequest: async () => ({ statusCode: 200 }) satisfies WebhookHttpResult,
    });

    const outcome = await executor.execute(ctx);
    expect(outcome.status).toBe("succeeded");
    if (outcome.status === "succeeded") {
      expect(outcome.responseMetadata?.statusCode).toBe(200);
    }
  });

  it("sends an explicitly-selected payload — never the raw Email row, never credentials", async () => {
    const { ctx } = await ctxFor("https://hooks.example.com/incoming");
    let capturedBody = "";
    const executor = createWebhookExecutor({
      dnsLookup: fakeDns,
      performRequest: async (input) => {
        capturedBody = input.body;
        return { statusCode: 200 };
      },
    });

    await executor.execute(ctx);
    const payload = JSON.parse(capturedBody);

    expect(payload).toMatchObject({
      schemaVersion: 1,
      event: "email.routed",
      email: {
        id: ctx.email.id,
        externalId: ctx.email.externalId,
        subject: "Quarterly proposal",
        sender: "alice@example.com",
        recipients: ctx.email.toAddresses,
      },
      routing: { destinationRef: ctx.routing.destinationRef, channelType: "webhook" },
      analysis: { signals: ctx.analysis?.signals },
    });

    // Explicitly NOT present — proves the payload is hand-built, not a spread of
    // the underlying database row/context.
    expect(payload).not.toHaveProperty("mailboxConnectionId");
    expect(payload).not.toHaveProperty("uidValidity");
    expect(payload).not.toHaveProperty("tenantId");
    expect(payload.email).not.toHaveProperty("ccAddresses");
    expect(payload.email).not.toHaveProperty("bccAddresses");
    expect(JSON.stringify(payload).toLowerCase()).not.toContain("password");
    expect(JSON.stringify(payload).toLowerCase()).not.toContain("secret");
  });

  it("signs the exact raw body with HMAC-SHA256 using the resolved secret, and includes the idempotency key header", async () => {
    const { ctx, tenant, destination } = await ctxFor("https://hooks.example.com/incoming", "signing_key");
    await setDestinationSecret(tenant.id, destination.id, "signing_key", "webhook-signing-secret");

    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";
    const executor = createWebhookExecutor({
      dnsLookup: fakeDns,
      performRequest: async (input) => {
        capturedHeaders = input.headers;
        capturedBody = input.body;
        return { statusCode: 200 };
      },
    });

    await executor.execute(ctx);

    const expectedSignature = createHmac("sha256", "webhook-signing-secret").update(capturedBody, "utf8").digest("hex");
    expect(capturedHeaders[WEBHOOK_SIGNATURE_HEADER]).toBe(expectedSignature);
    expect(capturedHeaders[WEBHOOK_IDEMPOTENCY_HEADER]).toBe(ctx.idempotencyKey);

    // The secret's plaintext value itself never appears anywhere in the request.
    const requestText = JSON.stringify({ url: "https://hooks.example.com/incoming", headers: capturedHeaders, body: capturedBody });
    expect(requestText).not.toContain("webhook-signing-secret");
  });

  it("sends no signature header when the channel has no secretName configured", async () => {
    const { ctx } = await ctxFor("https://hooks.example.com/incoming"); // no secretName
    let capturedHeaders: Record<string, string> = {};
    const executor = createWebhookExecutor({
      dnsLookup: fakeDns,
      performRequest: async (input) => {
        capturedHeaders = input.headers;
        return { statusCode: 200 };
      },
    });

    await executor.execute(ctx);
    expect(capturedHeaders[WEBHOOK_SIGNATURE_HEADER]).toBeUndefined();
  });

  it("a missing configured secret is a deterministic, permanent configuration failure — no request is sent", async () => {
    const { ctx } = await ctxFor("https://hooks.example.com/incoming", "never_configured");
    let requestSent = false;
    const executor = createWebhookExecutor({
      dnsLookup: fakeDns,
      performRequest: async () => {
        requestSent = true;
        return { statusCode: 200 };
      },
    });

    const outcome = await executor.execute(ctx);
    expect(outcome).toMatchObject({ status: "failed", retryable: false, errorClass: "invalid_config" });
    expect(requestSent).toBe(false);
  });

  it("SSRF: a webhook URL resolving to a private address is rejected before any request is sent", async () => {
    const { ctx } = await ctxFor("https://internal-looking.example.com/incoming");
    let requestSent = false;
    const executor = createWebhookExecutor({
      dnsLookup: async () => [{ address: "10.0.0.5", family: 4 }],
      performRequest: async () => {
        requestSent = true;
        return { statusCode: 200 };
      },
    });

    const outcome = await executor.execute(ctx);
    expect(outcome).toMatchObject({ status: "failed", retryable: false, errorClass: "ssrf_blocked" });
    expect(requestSent).toBe(false);
  });

  it("a malformed webhook URL is a permanent configuration failure, not an uncaught exception (the executor never throws)", async () => {
    const { ctx } = await ctxFor("not-a-valid-url");
    const executor = createWebhookExecutor({ dnsLookup: fakeDns, performRequest: async () => ({ statusCode: 200 }) });

    await expect(executor.execute(ctx)).resolves.toMatchObject({ status: "failed", retryable: false });
  });

  it("a response-lost transport error becomes 'ambiguous', not a blindly-retried failure", async () => {
    const { ctx } = await ctxFor("https://hooks.example.com/incoming");
    const executor = createWebhookExecutor({
      dnsLookup: fakeDns,
      performRequest: async () => {
        throw new WebhookResponseLostError("connection reset after the request was fully sent");
      },
    });

    const outcome = await executor.execute(ctx);
    expect(outcome.status).toBe("ambiguous");
  });

  it("a connection error (nothing could have reached the server) is a retryable failure", async () => {
    const { ctx } = await ctxFor("https://hooks.example.com/incoming");
    const executor = createWebhookExecutor({
      dnsLookup: fakeDns,
      performRequest: async () => {
        throw new WebhookConnectionError("ECONNREFUSED");
      },
    });

    const outcome = await executor.execute(ctx);
    expect(outcome).toMatchObject({ status: "failed", retryable: true, errorClass: "connection" });
  });
});
