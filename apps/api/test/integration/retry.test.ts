import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { finalizeFailedProcessing } from "../../src/queue/workers/processEmail.worker.js";
import { EmailState } from "../../src/types/email-state.js";
import { createReceivedEmail, createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";

// Phase 1's original placeholder-processing idempotency/simulated-failure tests
// lived here. That placeholder no longer exists (Phase 3 replaced it with real
// Jev analysis) — the equivalent, now-real behavior is tested in
// test/integration/jevAnalysis.test.ts. finalizeFailedProcessing itself was never
// part of the placeholder and is unchanged, so its tests stay exactly as they were.
describe("finalizeFailedProcessing — retries exhausted", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("moves the email to awaiting_review and opens exactly one HumanReviewItem", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "502");

    await finalizeFailedProcessing(email.id, "simulated exhaustion", 3);

    const refreshed = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
    expect(refreshed.state).toBe(EmailState.AWAITING_REVIEW);

    const reviewItems = await prisma.humanReviewItem.findMany({ where: { emailId: email.id } });
    expect(reviewItems).toHaveLength(1);
    expect(reviewItems[0]).toMatchObject({ reason: "failed", status: "open" });

    const eventTypes = (await prisma.auditEvent.findMany({ where: { emailId: email.id }, orderBy: { createdAt: "asc" } })).map(
      (e) => e.eventType,
    );
    expect(eventTypes).toEqual(["email_processing_failed", "email_routed_to_review"]);
  });

  it("is idempotent — calling it again for the same email does not open a second review item", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "503");

    await finalizeFailedProcessing(email.id, "first failure notification", 3);
    await finalizeFailedProcessing(email.id, "duplicate/redelivered failure notification", 3);

    const reviewItems = await prisma.humanReviewItem.findMany({ where: { emailId: email.id } });
    expect(reviewItems).toHaveLength(1);
  });
});
