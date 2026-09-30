import { beforeEach, describe, expect, it } from "vitest";
import type Mail from "nodemailer/lib/mailer/index.js";
import { prisma } from "../../src/db/client.js";
import { createForwardExecutor, type ForwardSender } from "../../src/modules/destinations/executors/forwardExecutor.js";
import { runForwardDigests } from "../../src/modules/destinations/forwardDigest.js";
import { forwardsSentLast24h } from "../../src/modules/destinations/forwardPolicy.js";
import { updateDestinationChannel } from "../../src/modules/destinations/manageDestinations.js";
import { updateSystemSettings } from "../../src/modules/settings/systemSettings.js";
import type { ExecutionContext } from "../../src/modules/destinations/executors/types.js";
import type { ForwardChannelConfig } from "../../src/modules/destinations/types.js";
import { BASIC_MESSAGE } from "../fixtures/rawMessages.js";
import { createReceivedEmail, createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";

const CONFIG: ForwardChannelConfig = { mode: "attachment", delivery: "digest", digestIntervalMinutes: 60, to: ["team@acme.test"] };
const HOUR = 60 * 60 * 1000;

async function setup(config: ForwardChannelConfig = CONFIG, emailCount = 2) {
  const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
  await updateSystemSettings({ smtpHost: "smtp.test.invalid", smtpFromAddress: "notify@acme.test" }, "admin@test");
  const destination = await prisma.destination.create({ data: { tenantId: tenant.id, name: "Marketing" } });
  const channel = await prisma.destinationChannel.create({ data: { tenantId: tenant.id, destinationId: destination.id, type: "forward", config: config as never as object, enabled: true, version: 1 } });
  await prisma.forwardRecipient.create({ data: { tenantId: tenant.id, address: "team@acme.test", status: "verified", verifiedAt: new Date() } });
  const emails = [];
  for (let i = 1; i <= emailCount; i += 1) {
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, String(i), { subject: `Offer ${i}` });
    await prisma.emailSource.create({ data: { emailId: email.id, tenantId: tenant.id, source: new Uint8Array(BASIC_MESSAGE), sizeBytes: BASIC_MESSAGE.length, expiresAt: new Date(Date.now() + 86_400_000) } });
    emails.push(email);
  }
  return { tenant, mailboxConnection, destination, channel, emails };
}

function ctxFor(s: Awaited<ReturnType<typeof setup>>, emailIndex: number): ExecutionContext {
  const email = s.emails[emailIndex]!;
  return {
    tenantId: s.tenant.id,
    email: { id: email.id, mailboxConnectionId: s.mailboxConnection.id, externalId: email.externalId, uidValidity: email.uidValidity, subject: email.subject ?? "", fromAddress: email.fromAddress, toAddresses: email.toAddresses },
    routing: { destinationRef: "Marketing" },
    channel: { id: s.channel.id, type: "forward", config: s.channel.config, destinationId: s.destination.id },
    idempotencyKey: `${email.id}:d:${s.channel.id}`,
  };
}

function capturingSender() {
  const sent: Mail.Options[] = [];
  const sender: ForwardSender = async (message) => {
    sent.push(message);
    return { messageId: "<id@smtp>", accepted: ["team@acme.test"], rejected: [] };
  };
  return { sent, sender };
}

const mustNotSend: ForwardSender = async () => {
  throw new Error("must not send");
};

async function queueAll(s: Awaited<ReturnType<typeof setup>>) {
  for (let i = 0; i < s.emails.length; i += 1) {
    const outcome = await createForwardExecutor(mustNotSend).execute(ctxFor(s, i));
    expect(outcome).toMatchObject({ status: "succeeded", responseMetadata: { delivery: "digest", queued: true } });
  }
}

describe("forward digests (Phase 13.4)", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("the executor queues instead of sending, once per email even if retried", async () => {
    const s = await setup();
    await queueAll(s);
    await createForwardExecutor(mustNotSend).execute(ctxFor(s, 0));
    expect(await prisma.forwardDigestItem.count({ where: { status: "queued" } })).toBe(2);
  });

  it("waits for the interval, then sends every queued email as one message", async () => {
    const s = await setup();
    await queueAll(s);
    const { sent, sender } = capturingSender();

    const early = await runForwardDigests(new Date(Date.now() + 10 * 60_000), sender);
    expect(early[0]?.outcome).toBe("not_due");
    expect(sent).toHaveLength(0);

    const due = await runForwardDigests(new Date(Date.now() + HOUR + 1000), sender);
    expect(due[0]).toMatchObject({ outcome: "sent", batchesSent: 1, emailsSent: 2 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.attachments).toHaveLength(2);
    expect(await prisma.forwardDigestBatch.findFirstOrThrow()).toMatchObject({ status: "sent", itemCount: 2 });
    expect(await prisma.auditEvent.count({ where: { eventType: "forward_digest_sent" } })).toBe(2);

    // Nothing left: the next run sends nothing.
    await runForwardDigests(new Date(Date.now() + 3 * HOUR), sender);
    expect(sent).toHaveLength(1);
  });

  it("the next digest waits a full interval after the previous one", async () => {
    const s = await setup(CONFIG, 1);
    await queueAll(s);
    const { sent, sender } = capturingSender();
    await runForwardDigests(new Date(Date.now() + HOUR + 1000), sender);
    const another = await createReceivedEmail(s.tenant.id, s.mailboxConnection.id, "99");
    await prisma.forwardDigestItem.create({ data: { tenantId: s.tenant.id, destinationChannelId: s.channel.id, emailId: another.id } });

    await runForwardDigests(new Date(Date.now() + HOUR + 60_000), sender);
    expect(sent).toHaveLength(1);
    await runForwardDigests(new Date(Date.now() + 2 * HOUR + 2000), sender);
    expect(sent).toHaveLength(2);
  });

  it("a connection failure before sending puts the emails back in the queue", async () => {
    const s = await setup();
    await queueAll(s);
    const failing: ForwardSender = async () => {
      throw Object.assign(new Error("refused"), { code: "ECONNECTION", command: "CONN" });
    };

    const result = await runForwardDigests(new Date(Date.now() + HOUR + 1000), failing);

    expect(result[0]?.outcome).toBe("retry_later");
    expect(await prisma.forwardDigestItem.count({ where: { status: "queued", batchId: null } })).toBe(2);
    expect(await prisma.humanReviewItem.count()).toBe(0);
  });

  it("a failure mid-send is ambiguous: nothing is resent, every email goes to Human Review", async () => {
    const s = await setup();
    await queueAll(s);
    const dropped: ForwardSender = async () => {
      throw Object.assign(new Error("socket closed"), { code: "ECONNECTION", command: "DATA" });
    };

    const result = await runForwardDigests(new Date(Date.now() + HOUR + 1000), dropped);

    expect(result[0]?.outcome).toBe("ambiguous");
    expect(await prisma.forwardDigestBatch.findFirstOrThrow()).toMatchObject({ status: "ambiguous" });
    expect(await prisma.forwardDigestItem.count({ where: { status: "queued" } })).toBe(0);
    expect(await prisma.humanReviewItem.count({ where: { reason: "execution_ambiguous" } })).toBe(2);
  });

  it("no confirmed recipient left at send time: the batch fails and the emails go to Human Review", async () => {
    const s = await setup();
    await queueAll(s);
    await prisma.forwardRecipient.updateMany({ data: { status: "revoked" } });

    const result = await runForwardDigests(new Date(Date.now() + HOUR + 1000), mustNotSend);

    expect(result[0]?.outcome).toBe("failed");
    expect(await prisma.humanReviewItem.count({ where: { reason: "execution_failed" } })).toBe(2);
  });

  it("disabling the channel cancels its queued emails", async () => {
    const s = await setup();
    await queueAll(s);
    await prisma.destinationChannel.update({ where: { id: s.channel.id }, data: { enabled: false, deactivatedAt: new Date() } });

    const result = await runForwardDigests(new Date(Date.now() + HOUR + 1000), mustNotSend);

    expect(result[0]?.outcome).toBe("cancelled");
    expect(await prisma.forwardDigestItem.count({ where: { status: "cancelled" } })).toBe(2);
    expect(await prisma.auditEvent.count({ where: { eventType: "forward_digest_cancelled" } })).toBe(2);
  });

  it("editing the channel carries its queued emails over to the new version", async () => {
    const s = await setup();
    await queueAll(s);
    const updated = await updateDestinationChannel(s.channel.id, { type: "forward", config: { ...CONFIG, fromName: "Bot" } as never as object });

    expect(await prisma.forwardDigestItem.count({ where: { destinationChannelId: updated.id, status: "queued" } })).toBe(2);
    const { sent, sender } = capturingSender();
    await runForwardDigests(new Date(Date.now() + HOUR + 1000), sender);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.from).toEqual({ name: "Bot", address: "notify@acme.test" });
  });

  it("switching a channel back to 'each' flushes its queue on the next run", async () => {
    const s = await setup();
    await queueAll(s);
    await updateDestinationChannel(s.channel.id, { type: "forward", config: { mode: "attachment", to: ["team@acme.test"] } as never as object });
    const { sent, sender } = capturingSender();
    await runForwardDigests(new Date(), sender);
    expect(sent).toHaveLength(1);
  });

  it("without SMTP the queue waits instead of failing", async () => {
    const s = await setup();
    await queueAll(s);
    await updateSystemSettings({ smtpHost: null }, "admin@test");

    const result = await runForwardDigests(new Date(Date.now() + HOUR + 1000), mustNotSend);

    expect(result[0]?.outcome).toBe("smtp_not_configured");
    expect(await prisma.forwardDigestItem.count({ where: { status: "queued" } })).toBe(2);
    expect(await prisma.forwardDigestBatch.count()).toBe(0);
  });

  it("a batch left 'sending' by a crashed worker is resolved as ambiguous", async () => {
    const s = await setup();
    const batch = await prisma.forwardDigestBatch.create({ data: { tenantId: s.tenant.id, destinationChannelId: s.channel.id, status: "sending", itemCount: 1, createdAt: new Date(Date.now() - HOUR) } });
    await prisma.forwardDigestItem.create({ data: { tenantId: s.tenant.id, destinationChannelId: s.channel.id, emailId: s.emails[0]!.id, status: "batched", batchId: batch.id } });

    await runForwardDigests(new Date(), mustNotSend);

    expect(await prisma.forwardDigestBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject({ status: "ambiguous", errorClass: "stale_sending" });
    expect(await prisma.humanReviewItem.count({ where: { reason: "execution_ambiguous" } })).toBe(1);
  });

  it("the daily limit counts a digest as one message and doesn't count queuing", async () => {
    const s = await setup(CONFIG, 3);
    // Queue via the full executeAction path so succeeded executions exist.
    const { executeAction } = await import("../../src/modules/destinations/executeAction.js");
    const { computeIdempotencyKey } = await import("../../src/modules/destinations/idempotency.js");
    for (const email of s.emails) {
      const decision = await prisma.routingDecision.create({ data: { tenantId: s.tenant.id, emailId: email.id, status: "matched", destinationRef: "Marketing" } });
      await executeAction({ emailId: email.id, routingDecisionId: decision.id, destinationChannelId: s.channel.id, idempotencyKey: computeIdempotencyKey(email.id, decision.id, s.channel.id) }, { forward: createForwardExecutor(mustNotSend) });
    }
    expect(await forwardsSentLast24h(s.tenant.id)).toBe(0);

    await runForwardDigests(new Date(Date.now() + HOUR + 1000), capturingSender().sender);
    expect(await forwardsSentLast24h(s.tenant.id)).toBe(1);
  });
});
