import { beforeEach, describe, expect, it } from "vitest";
import { buildTestServer } from "./helpers/buildTestServer.js";
import { createReceivedEmail, createSuccessfulAnalysis, createTestTenantAndMailbox, defaultAnswers, resetDatabase } from "../helpers/db.js";
import { escalateToHumanReview } from "../../src/modules/review/escalate.js";
import { prisma } from "../../src/db/client.js";

describe("API — human review", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("lists review items, filterable by status", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
    await escalateToHumanReview(tenant.id, email.id, { errorMessage: "no rule matched", attemptsMade: 0, reason: "unmatched" });
    const app = buildTestServer(tenant.id);

    const open = await app.inject({ method: "GET", url: "/api/v1/reviews?status=open" });
    expect(open.json().data).toHaveLength(1);

    const resolved = await app.inject({ method: "GET", url: "/api/v1/reviews?status=resolved" });
    expect(resolved.json().data).toHaveLength(0);
    await app.close();
  });

  it("filters by reason and emailId", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
    await escalateToHumanReview(tenant.id, email.id, { errorMessage: "no rule matched", attemptsMade: 0, reason: "unmatched" });
    const app = buildTestServer(tenant.id);

    const byReason = await app.inject({ method: "GET", url: "/api/v1/reviews?reason=unmatched" });
    expect(byReason.json().data).toHaveLength(1);

    const byWrongReason = await app.inject({ method: "GET", url: "/api/v1/reviews?reason=failed" });
    expect(byWrongReason.json().data).toHaveLength(0);

    const byEmail = await app.inject({ method: "GET", url: `/api/v1/reviews?emailId=${email.id}` });
    expect(byEmail.json().data).toHaveLength(1);
    await app.close();
  });

  it("detail includes email/analysis/routing context and recent audit history", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
    await escalateToHumanReview(tenant.id, email.id, { errorMessage: "no rule matched", attemptsMade: 0, reason: "unmatched" });
    const item = await prisma.humanReviewItem.findFirstOrThrow({ where: { emailId: email.id } });
    const app = buildTestServer(tenant.id);

    const res = await app.inject({ method: "GET", url: `/api/v1/reviews/${item.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.email.id).toBe(email.id);
    expect(body.reason).toBe("unmatched");
    expect(Array.isArray(body.recentAuditEvents)).toBe(true);
    expect(body.recentAuditEvents.length).toBeGreaterThan(0);
    await app.close();
  });

  it("resolve is deterministic and idempotent — calling it twice does not error or change resolvedAt the second time", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
    await escalateToHumanReview(tenant.id, email.id, { errorMessage: "no rule matched", attemptsMade: 0, reason: "unmatched" });
    const item = await prisma.humanReviewItem.findFirstOrThrow({ where: { emailId: email.id } });
    const app = buildTestServer(tenant.id);

    const first = await app.inject({ method: "POST", url: `/api/v1/reviews/${item.id}/resolve` });
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe("resolved");
    const firstResolvedAt = first.json().resolvedAt;

    const second = await app.inject({ method: "POST", url: `/api/v1/reviews/${item.id}/resolve` });
    expect(second.statusCode).toBe(200);
    expect(second.json().resolvedAt).toBe(firstResolvedAt); // unchanged, not re-stamped

    const rows = await prisma.humanReviewItem.findMany({ where: { emailId: email.id } });
    expect(rows).toHaveLength(1); // no duplicate created
    await app.close();
  });

  it("resolving an unknown review item is 404", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "POST", url: "/api/v1/reviews/does-not-exist/resolve" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("a review item belonging to a different tenant cannot be resolved", async () => {
    const { tenant: tenantA } = await createTestTenantAndMailbox();
    const { tenant: tenantB, mailboxConnection: mailboxB } = await createTestTenantAndMailbox();
    const emailB = await createReceivedEmail(tenantB.id, mailboxB.id, "1");
    await escalateToHumanReview(tenantB.id, emailB.id, { errorMessage: "x", attemptsMade: 0, reason: "unmatched" });
    const item = await prisma.humanReviewItem.findFirstOrThrow({ where: { emailId: emailB.id } });

    const appA = buildTestServer(tenantA.id);
    const res = await appA.inject({ method: "POST", url: `/api/v1/reviews/${item.id}/resolve` });
    expect(res.statusCode).toBe(404);

    const untouched = await prisma.humanReviewItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(untouched.status).toBe("open");
    await appA.close();
  });

  describe("resolution classification (Phase 10.2)", () => {
    it("resolving with { resolution: \"spam\" } persists it and returns it", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
      await escalateToHumanReview(tenant.id, email.id, { errorMessage: "no rule matched", attemptsMade: 0, reason: "unmatched" });
      const item = await prisma.humanReviewItem.findFirstOrThrow({ where: { emailId: email.id } });
      const app = buildTestServer(tenant.id);

      const res = await app.inject({ method: "POST", url: `/api/v1/reviews/${item.id}/resolve`, payload: { resolution: "spam" } });
      expect(res.statusCode).toBe(200);
      expect(res.json().resolution).toBe("spam");
      await app.close();
    });

    it("resolving with { resolution: \"approved\" } persists it", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
      await escalateToHumanReview(tenant.id, email.id, { errorMessage: "no rule matched", attemptsMade: 0, reason: "unmatched" });
      const item = await prisma.humanReviewItem.findFirstOrThrow({ where: { emailId: email.id } });
      const app = buildTestServer(tenant.id);

      const res = await app.inject({ method: "POST", url: `/api/v1/reviews/${item.id}/resolve`, payload: { resolution: "approved" } });
      expect(res.statusCode).toBe(200);
      expect(res.json().resolution).toBe("approved");
      await app.close();
    });

    it("resolving with no body still works exactly as before — resolution stays null", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
      await escalateToHumanReview(tenant.id, email.id, { errorMessage: "no rule matched", attemptsMade: 0, reason: "unmatched" });
      const item = await prisma.humanReviewItem.findFirstOrThrow({ where: { emailId: email.id } });
      const app = buildTestServer(tenant.id);

      const res = await app.inject({ method: "POST", url: `/api/v1/reviews/${item.id}/resolve` });
      expect(res.statusCode).toBe(200);
      expect(res.json().resolution).toBeNull();
      await app.close();
    });

    it("rejects an invalid resolution value", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
      await escalateToHumanReview(tenant.id, email.id, { errorMessage: "no rule matched", attemptsMade: 0, reason: "unmatched" });
      const item = await prisma.humanReviewItem.findFirstOrThrow({ where: { emailId: email.id } });
      const app = buildTestServer(tenant.id);

      const res = await app.inject({ method: "POST", url: `/api/v1/reviews/${item.id}/resolve`, payload: { resolution: "not-a-real-resolution" } });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("resolving an already-resolved item with a different resolution does not overwrite the original — idempotent no-op", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
      await escalateToHumanReview(tenant.id, email.id, { errorMessage: "no rule matched", attemptsMade: 0, reason: "unmatched" });
      const item = await prisma.humanReviewItem.findFirstOrThrow({ where: { emailId: email.id } });
      const app = buildTestServer(tenant.id);

      await app.inject({ method: "POST", url: `/api/v1/reviews/${item.id}/resolve`, payload: { resolution: "approved" } });
      const second = await app.inject({ method: "POST", url: `/api/v1/reviews/${item.id}/resolve`, payload: { resolution: "spam" } });
      expect(second.json().resolution).toBe("approved"); // unchanged
      await app.close();
    });

    it("records a human_review_resolved audit event with the resolution, never any credential/secret data", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
      await escalateToHumanReview(tenant.id, email.id, { errorMessage: "no rule matched", attemptsMade: 0, reason: "unmatched" });
      const item = await prisma.humanReviewItem.findFirstOrThrow({ where: { emailId: email.id } });
      const app = buildTestServer(tenant.id);

      await app.inject({ method: "POST", url: `/api/v1/reviews/${item.id}/resolve`, payload: { resolution: "spam" } });
      const events = await prisma.auditEvent.findMany({ where: { tenantId: tenant.id, eventType: "human_review_resolved" } });
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({ reviewItemId: item.id, resolution: "spam" });
      await app.close();
    });
  });

  describe("list enrichment — real emailPreview and Jev-derived signal (Phase 10.2)", () => {
    it("includes the real email subject/sender and a real is_spam-derived signal", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1", { subject: "Wire transfer request" });
      await createSuccessfulAnalysis(tenant.id, email.id, defaultAnswers({ is_spam: { noul: 0.92 } }));
      await escalateToHumanReview(tenant.id, email.id, { errorMessage: "no rule matched", attemptsMade: 0, reason: "unmatched" });
      const app = buildTestServer(tenant.id);

      const res = await app.inject({ method: "GET", url: "/api/v1/reviews" });
      const row = res.json().data[0];
      expect(row.emailPreview).toMatchObject({ subject: "Wire transfer request", fromAddress: email.fromAddress });
      expect(row.signal.isSpam).toBeCloseTo(0.92);
      expect(row.signal.isSuspicious).toBe(true); // >= the same 0.5 threshold conditions.ts already uses
      expect(row.signal.category).toBe("business_opportunity"); // from defaultAnswers()
      await app.close();
    });

    it("signal is null when no successful analysis exists yet", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
      await escalateToHumanReview(tenant.id, email.id, { errorMessage: "processing failed", attemptsMade: 3, reason: "failed" });
      const app = buildTestServer(tenant.id);

      const res = await app.inject({ method: "GET", url: "/api/v1/reviews" });
      expect(res.json().data[0].signal).toBeNull();
      await app.close();
    });

    it("a low is_spam score is marked NOT suspicious (likely safe)", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
      await createSuccessfulAnalysis(tenant.id, email.id, defaultAnswers({ is_spam: { noul: 0.03 } }));
      await escalateToHumanReview(tenant.id, email.id, { errorMessage: "no rule matched", attemptsMade: 0, reason: "unmatched" });
      const app = buildTestServer(tenant.id);

      const res = await app.inject({ method: "GET", url: "/api/v1/reviews" });
      expect(res.json().data[0].signal.isSuspicious).toBe(false);
      await app.close();
    });
  });

  it("resolving the last open item moves the email out of awaiting_review, so the Emails list stops showing it as waiting", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "rv-1");
    await escalateToHumanReview(tenant.id, email.id, { errorMessage: "no rule matched", attemptsMade: 0, reason: "unmatched" });
    // escalate keeps one open item per email; a second one can exist from older data or other paths.
    await prisma.humanReviewItem.create({ data: { tenantId: tenant.id, emailId: email.id, reason: "execution_failed", status: "open" } });
    const [first, second] = await prisma.humanReviewItem.findMany({ where: { emailId: email.id }, orderBy: { createdAt: "asc" } });
    const app = buildTestServer(tenant.id);

    await app.inject({ method: "POST", url: `/api/v1/reviews/${first!.id}/resolve`, payload: { resolution: "approved" } });
    expect((await prisma.email.findUniqueOrThrow({ where: { id: email.id } })).state).toBe("awaiting_review");

    await app.inject({ method: "POST", url: `/api/v1/reviews/${second!.id}/resolve`, payload: { resolution: "spam" } });
    expect((await prisma.email.findUniqueOrThrow({ where: { id: email.id } })).state).toBe("reviewed");

    const waiting = (await app.inject({ method: "GET", url: "/api/v1/emails?state=awaiting_review" })).json().data;
    expect(waiting).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: "/api/v1/emails?state=reviewed" })).json().data).toHaveLength(1);
  });
});
