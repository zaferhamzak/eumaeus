import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { finalizeExhaustedAction } from "../../src/queue/workers/executeAction.worker.js";
import {
  createArchiveDestination,
  createMatchedRoutingDecision,
  createReceivedEmail,
  createSuccessfulAnalysis,
  createTestTenantAndMailbox,
  defaultAnswers,
  resetDatabase,
} from "../helpers/db.js";
import { computeIdempotencyKey } from "../../src/modules/destinations/idempotency.js";

/**
 * Covers "Worker/process crash sonrası stale pending recovery çalışıyor" and "Aynı
 * failure tekrar işlense bile duplicate HumanReviewItem oluşmuyor" specifically for
 * the BullMQ-attempts-exhausted backstop path — complementary to
 * actionExecution.test.ts's coverage of executeAction()'s own self-check, which is
 * the PRIMARY recovery mechanism (this phase's explicit instruction: the DB-level
 * self-check is authoritative; this backstop is a second, not the first, layer).
 */
describe("finalizeExhaustedAction — the worker.on('failed') backstop", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  async function setup() {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
    const analysis = await createSuccessfulAnalysis(tenant.id, email.id, defaultAnswers());
    const { destination, channel } = await createArchiveDestination(tenant.id, "archive-dest");
    const routingDecision = await createMatchedRoutingDecision(tenant.id, email.id, destination.name, analysis.id);
    const idempotencyKey = computeIdempotencyKey(email.id, routingDecision.id, channel.id);
    return { tenant, email, channel, routingDecision, idempotencyKey };
  }

  it("a still-pending execution when attempts are exhausted (worker crashed and no self-check ever ran again) is finalized ambiguous and escalated", async () => {
    const { tenant, email, channel, routingDecision, idempotencyKey } = await setup();
    await prisma.actionExecution.create({
      data: {
        tenantId: tenant.id,
        emailId: email.id,
        routingDecisionId: routingDecision.id,
        destinationChannelId: channel.id,
        channelType: "archive",
        channelVersion: 1,
        idempotencyKey,
        attemptNumber: 1,
        status: "pending",
      },
    });

    await finalizeExhaustedAction(idempotencyKey, "job stalled repeatedly", 5);

    const execution = await prisma.actionExecution.findFirstOrThrow({ where: { idempotencyKey } });
    expect(execution.status).toBe("ambiguous");
    const reviewItems = await prisma.humanReviewItem.findMany({ where: { emailId: email.id } });
    expect(reviewItems[0]).toMatchObject({ reason: "execution_ambiguous" });
  });

  it("a genuinely-failed (retryable) execution, once attempts are exhausted, escalates as execution_failed", async () => {
    const { tenant, email, channel, routingDecision, idempotencyKey } = await setup();
    await prisma.actionExecution.create({
      data: {
        tenantId: tenant.id,
        emailId: email.id,
        routingDecisionId: routingDecision.id,
        destinationChannelId: channel.id,
        channelType: "archive",
        channelVersion: 1,
        idempotencyKey,
        attemptNumber: 5,
        status: "failed",
        retryable: true,
        errorClass: "connection",
        errorMessage: "ECONNREFUSED",
      },
    });

    await finalizeExhaustedAction(idempotencyKey, "ECONNREFUSED", 5);

    const reviewItems = await prisma.humanReviewItem.findMany({ where: { emailId: email.id } });
    expect(reviewItems[0]).toMatchObject({ reason: "execution_failed" });
  });

  it("calling it twice for the same exhausted execution does not create a duplicate HumanReviewItem", async () => {
    const { tenant, email, channel, routingDecision, idempotencyKey } = await setup();
    await prisma.actionExecution.create({
      data: {
        tenantId: tenant.id,
        emailId: email.id,
        routingDecisionId: routingDecision.id,
        destinationChannelId: channel.id,
        channelType: "archive",
        channelVersion: 1,
        idempotencyKey,
        attemptNumber: 1,
        status: "pending",
      },
    });

    await finalizeExhaustedAction(idempotencyKey, "first notification", 5);
    await finalizeExhaustedAction(idempotencyKey, "duplicate/redelivered notification", 5);

    const reviewItems = await prisma.humanReviewItem.findMany({ where: { emailId: email.id } });
    expect(reviewItems).toHaveLength(1);
  });
});
