import { beforeEach, describe, expect, it } from "vitest";
import type Mail from "nodemailer/lib/mailer/index.js";
import { prisma } from "../../src/db/client.js";
import { createForwardExecutor, type ForwardSender } from "../../src/modules/destinations/executors/forwardExecutor.js";
import { executeAction } from "../../src/modules/destinations/executeAction.js";
import { computeIdempotencyKey } from "../../src/modules/destinations/idempotency.js";
import { updateSystemSettings } from "../../src/modules/settings/systemSettings.js";
import type { ExecutionContext } from "../../src/modules/destinations/executors/types.js";
import type { ForwardChannelConfig } from "../../src/modules/destinations/types.js";
import { BASIC_MESSAGE } from "../fixtures/rawMessages.js";
import { createMatchedRoutingDecision, createReceivedEmail, createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";

const SMTP = { smtpHost: "smtp.test.invalid", smtpFromAddress: "notify@acme.test", smtpFromName: "Eumaeus" };

async function setup(config: Partial<ForwardChannelConfig> = {}, options: { verify?: string[]; smtp?: boolean } = {}) {
  const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
  if (options.smtp !== false) await updateSystemSettings(SMTP, "admin@test");
  const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1", { subject: "September sale", fromAddress: "promo@brand.test" });
  await prisma.emailSource.create({
    data: { emailId: email.id, tenantId: tenant.id, source: new Uint8Array(BASIC_MESSAGE), sizeBytes: BASIC_MESSAGE.length, expiresAt: new Date(Date.now() + 86_400_000) },
  });
  const fullConfig: ForwardChannelConfig = { mode: "attachment", to: ["team@acme.test"], ...config };
  const destination = await prisma.destination.create({ data: { tenantId: tenant.id, name: "Marketing" } });
  const channel = await prisma.destinationChannel.create({
    data: { tenantId: tenant.id, destinationId: destination.id, type: "forward", config: fullConfig as never as object, enabled: true, version: 1 },
  });
  for (const address of options.verify ?? ["team@acme.test"]) {
    await prisma.forwardRecipient.create({ data: { tenantId: tenant.id, address, status: "verified", verifiedAt: new Date() } });
  }
  const ctx: ExecutionContext = {
    tenantId: tenant.id,
    email: { id: email.id, mailboxConnectionId: mailboxConnection.id, externalId: email.externalId, uidValidity: email.uidValidity, subject: "September sale", fromAddress: email.fromAddress, toAddresses: email.toAddresses },
    routing: { destinationRef: "Marketing" },
    analysis: { signals: { category: { choice: "marketing" } } },
    channel: { id: channel.id, type: "forward", config: fullConfig, destinationId: destination.id },
    idempotencyKey: `${email.id}:decision:${channel.id}`,
  };
  return { tenant, mailboxConnection, email, destination, channel, ctx };
}

function capturingSender() {
  const sent: Mail.Options[] = [];
  const sender: ForwardSender = async (message) => {
    sent.push(message);
    return { messageId: "<server-id@smtp>", accepted: ["team@acme.test"], rejected: [] };
  };
  return { sent, sender };
}

function failingSender(fields: Record<string, unknown>): ForwardSender {
  return async () => {
    throw Object.assign(new Error("smtp failure"), fields);
  };
}

describe("forwardExecutor", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("forwards the stored original to verified recipients", async () => {
    const { ctx } = await setup();
    const { sent, sender } = capturingSender();

    const outcome = await createForwardExecutor(sender).execute(ctx);

    expect(outcome.status).toBe("succeeded");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toEqual(["team@acme.test"]);
    expect(sent[0]?.subject).toBe("Fwd: September sale");
    expect(sent[0]?.attachments?.[0]?.contentType).toBe("message/rfc822");
    if (outcome.status === "succeeded") expect(outcome.responseMetadata).toMatchObject({ mode: "attachment", usedOriginalSource: true, skipped: [] });
  });

  it("skips unverified recipients and reports them, still sending to the rest", async () => {
    const { ctx } = await setup({ to: ["team@acme.test"], cc: ["new@acme.test"] });
    const { sent, sender } = capturingSender();

    const outcome = await createForwardExecutor(sender).execute(ctx);

    expect(outcome.status).toBe("succeeded");
    expect(sent[0]?.cc).toBeUndefined();
    if (outcome.status === "succeeded") expect(outcome.responseMetadata?.skipped).toEqual([{ address: "new@acme.test", reason: "unverified" }]);
  });

  it("fails permanently when no recipient is deliverable", async () => {
    const { ctx } = await setup({}, { verify: [] });
    const outcome = await createForwardExecutor(capturingSender().sender).execute(ctx);
    expect(outcome).toMatchObject({ status: "failed", retryable: false, errorClass: "no_deliverable_recipients" });
  });

  it("enforces the organization's domain allowlist at send time", async () => {
    const { ctx, tenant } = await setup();
    await prisma.tenant.update({ where: { id: tenant.id }, data: { forwardAllowedDomains: ["partner.test"] } });
    const outcome = await createForwardExecutor(capturingSender().sender).execute(ctx);
    expect(outcome).toMatchObject({ status: "failed", errorClass: "no_deliverable_recipients" });
    if (outcome.status === "failed") expect(outcome.errorMessage).toContain("domain_not_allowed");
  });

  it("never forwards to a mailbox the organization monitors", async () => {
    const { ctx } = await setup({ to: ["bob@eumaeus.test"] }, { verify: ["bob@eumaeus.test"] });
    const outcome = await createForwardExecutor(capturingSender().sender).execute(ctx);
    expect(outcome).toMatchObject({ status: "failed", errorClass: "no_deliverable_recipients" });
    if (outcome.status === "failed") expect(outcome.errorMessage).toContain("monitored_mailbox");
  });

  it("refuses to forward a message Eumaeus itself forwarded (loop protection)", async () => {
    const { ctx, email } = await setup();
    await prisma.email.update({ where: { id: email.id }, data: { forwardedByEumaeus: true } });
    const { sent, sender } = capturingSender();
    const outcome = await createForwardExecutor(sender).execute(ctx);
    expect(outcome).toMatchObject({ status: "failed", retryable: false, errorClass: "loop_detected" });
    expect(sent).toHaveLength(0);
  });

  it("fails permanently with a clear message when SMTP isn't configured", async () => {
    const { ctx } = await setup({}, { smtp: false });
    const outcome = await createForwardExecutor(capturingSender().sender).execute(ctx);
    expect(outcome).toMatchObject({ status: "failed", retryable: false, errorClass: "invalid_config" });
  });

  it("stops at the daily limit", async () => {
    const { ctx, tenant, email, channel } = await setup();
    await prisma.tenant.update({ where: { id: tenant.id }, data: { forwardDailyLimit: 1 } });
    const decision = await createMatchedRoutingDecision(tenant.id, email.id, "Marketing");
    await prisma.actionExecution.create({
      data: { tenantId: tenant.id, emailId: email.id, routingDecisionId: decision.id, destinationChannelId: channel.id, channelType: "forward", channelVersion: 1, idempotencyKey: "earlier", attemptNumber: 1, status: "succeeded", completedAt: new Date() },
    });
    const outcome = await createForwardExecutor(capturingSender().sender).execute(ctx);
    expect(outcome).toMatchObject({ status: "failed", retryable: false, errorClass: "rate_limited" });
  });

  it("a connection failure before sending is retryable; a failure during DATA is ambiguous", async () => {
    const { ctx } = await setup();
    expect(await createForwardExecutor(failingSender({ code: "ECONNECTION", command: "CONN" })).execute(ctx)).toMatchObject({ status: "failed", retryable: true, errorClass: "connection" });
    expect((await createForwardExecutor(failingSender({ code: "ECONNECTION", command: "DATA" })).execute(ctx)).status).toBe("ambiguous");
    expect(await createForwardExecutor(failingSender({ code: "EENVELOPE", command: "RCPT TO", responseCode: 550 })).execute(ctx)).toMatchObject({ status: "failed", retryable: false, errorClass: "smtp_rejected" });
  });

  it("runs end to end through executeAction and records a succeeded execution", async () => {
    const { tenant, email, channel } = await setup();
    const decision = await createMatchedRoutingDecision(tenant.id, email.id, "Marketing");
    const { sent, sender } = capturingSender();

    await executeAction(
      { emailId: email.id, routingDecisionId: decision.id, destinationChannelId: channel.id, idempotencyKey: computeIdempotencyKey(email.id, decision.id, channel.id) },
      { forward: createForwardExecutor(sender) },
    );

    expect(sent).toHaveLength(1);
    const execution = await prisma.actionExecution.findFirstOrThrow({ where: { emailId: email.id } });
    expect(execution).toMatchObject({ status: "succeeded", channelType: "forward" });
  });
});
