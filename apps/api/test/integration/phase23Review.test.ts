import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: Array<{ to: string; subject: string; html: string; text: string }> = [];
vi.mock("../../src/modules/email/mailer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/modules/email/mailer.js")>()),
  isMailerConfigured: async () => true,
  sendEmail: async (input: { to: string; subject: string; html: string; text: string }) => {
    sent.push(input);
  },
}));

const { prisma } = await import("../../src/db/client.js");
const { buildServer } = await import("../../src/api/server.js");
const { buildTestServer } = await import("../api/helpers/buildTestServer.js");
const { runReviewDigests } = await import("../../src/modules/review/reviewDigest.js");
const { createReviewActionToken, verifyReviewActionToken, ReviewActionError } = await import("../../src/modules/review/reviewActionTokens.js");
const { escalateToHumanReview } = await import("../../src/modules/review/escalate.js");
const { createReceivedEmail, createTestTenantAndMailbox, resetDatabase } = await import("../helpers/db.js");
const { createTestMembership, createTestUser } = await import("../helpers/auth.js");

async function openItem(tenantId: string, mailboxId: string, uid: string, from: string, subject: string) {
  const e = await createReceivedEmail(tenantId, mailboxId, uid, { fromAddress: from, subject });
  await escalateToHumanReview(tenantId, e.id, { errorMessage: "x", attemptsMade: 0, reason: "unmatched" });
  return prisma.humanReviewItem.findFirstOrThrow({ where: { emailId: e.id } });
}

function asUser(user: { id: string; email: string }) {
  return buildServer({ logger: false, authResolver: async () => ({ id: user.id, email: user.email, isSuperAdmin: false }) });
}

describe("Phase 23 — faster Human Review", () => {
  beforeEach(async () => {
    await resetDatabase();
    sent.length = 0;
  });

  it("review routes now require reviews:read / reviews:resolve, and record who decided", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const item = await openItem(tenant.id, mailboxConnection.id, "1", "a@shop.test", "Hello");
    const headers = { "x-organization-id": tenant.id };
    const nobody = await createTestUser();
    await createTestMembership(nobody.id, tenant.id, ["emails:read"]);
    expect((await asUser(nobody).inject({ method: "GET", url: "/api/v1/reviews", headers })).statusCode).toBe(403);
    expect((await asUser(nobody).inject({ method: "POST", url: `/api/v1/reviews/${item.id}/resolve`, headers, payload: { resolution: "spam" } })).statusCode).toBe(403);

    const reader = await createTestUser();
    await createTestMembership(reader.id, tenant.id, ["reviews:read"]);
    expect((await asUser(reader).inject({ method: "GET", url: "/api/v1/reviews", headers })).statusCode).toBe(200);
    expect((await asUser(reader).inject({ method: "POST", url: `/api/v1/reviews/${item.id}/resolve`, headers, payload: {} })).statusCode).toBe(403);

    const decider = await createTestUser({ email: "decider@acme.test" });
    await createTestMembership(decider.id, tenant.id, ["reviews:read", "reviews:resolve"]);
    expect((await asUser(decider).inject({ method: "POST", url: `/api/v1/reviews/${item.id}/resolve`, headers, payload: { resolution: "spam" } })).json()).toMatchObject({ status: "resolved", resolution: "spam" });
    expect(await prisma.auditEvent.count({ where: { eventType: "human_review_resolved", actor: "decider@acme.test" } })).toBe(1);
  });

  it("finds the other open items from the sender (optionally sharing a subject word) and decides them together", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const m = mailboxConnection.id;
    const first = await openItem(tenant.id, m, "1", "news@mail.shop.test", "Weekly deals 1");
    await openItem(tenant.id, m, "2", "promo@mail.shop.test", "Weekly deals 2");
    await openItem(tenant.id, m, "3", "news@mail.shop.test", "Your receipt");
    await openItem(tenant.id, m, "4", "someone@other.test", "Weekly deals 3");
    const app = buildTestServer(tenant.id);

    const all = (await app.inject({ method: "GET", url: `/api/v1/reviews/${first.id}/similar` })).json();
    expect(all).toMatchObject({ sender: "mail.shop.test", word: null });
    expect(all.items).toHaveLength(2);
    expect(all.words).toEqual(expect.arrayContaining(["weekly", "deals"]));
    const deals = (await app.inject({ method: "GET", url: `/api/v1/reviews/${first.id}/similar?word=deals` })).json();
    expect(deals.items.map((i: { subject: string }) => i.subject)).toEqual(["Weekly deals 2"]);

    const bulk = await app.inject({ method: "POST", url: "/api/v1/reviews/resolve", payload: { itemIds: [first.id, ...deals.items.map((i: { id: string }) => i.id), "nope"], resolution: "spam" } });
    expect(bulk.json()).toMatchObject({ resolved: 2, skipped: 1 });
    expect(await prisma.humanReviewItem.count({ where: { tenantId: tenant.id, status: "open" } })).toBe(2);
    expect(await prisma.auditEvent.count({ where: { tenantId: tenant.id, eventType: "human_review_resolved" } })).toBe(2);
  });

  it("digest emails carry signed one-click links only for members who may decide; preview decides nothing, confirm does", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    await prisma.tenant.update({ where: { id: tenant.id }, data: { reviewDigestEnabled: true, reviewDigestIntervalMinutes: 60, lastReviewDigestAt: new Date(Date.now() - 2 * 3600_000) } });
    const decider = await createTestUser({ email: "decider@acme.test" });
    await createTestMembership(decider.id, tenant.id, ["reviews:resolve"]);
    const reader = await createTestUser({ email: "reader@acme.test" });
    await createTestMembership(reader.id, tenant.id, ["reviews:read"]);
    const item = await openItem(tenant.id, mailboxConnection.id, "1", "x@spam.test", "Buy now");

    await runReviewDigests();
    const toDecider = sent.find((m) => m.to === "decider@acme.test")!;
    const toReader = sent.find((m) => m.to === "reader@acme.test")!;
    expect(toReader.text).not.toContain("/review-action?token=");
    const url = /Spam: (\S+)/.exec(toDecider.text)![1]!;
    const token = decodeURIComponent(new URL(url).searchParams.get("token")!);

    const app = buildServer({ logger: false });
    const preview = (await app.inject({ method: "GET", url: `/api/v1/review-actions/preview?token=${encodeURIComponent(token)}` })).json();
    expect(preview).toMatchObject({ resolution: "spam", subject: "Buy now", alreadyClosed: false });
    expect((await prisma.humanReviewItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("open");

    const done = (await app.inject({ method: "POST", url: "/api/v1/review-actions", payload: { token } })).json();
    expect(done).toMatchObject({ resolved: true, status: "resolved" });
    expect(await prisma.humanReviewItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ resolution: "spam" });
    expect(await prisma.auditEvent.count({ where: { eventType: "human_review_resolved", actor: "decider@acme.test" } })).toBe(1);
    // Single effect: a second click changes nothing.
    expect((await app.inject({ method: "POST", url: "/api/v1/review-actions", payload: { token } })).json()).toMatchObject({ resolved: false, alreadyClosed: true });
  });

  it("rejects tampered and expired links, and a recipient who lost the permission", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const user = await createTestUser();
    const membership = await createTestMembership(user.id, tenant.id, ["reviews:resolve"]);
    const item = await openItem(tenant.id, mailboxConnection.id, "1", "x@spam.test", "Buy now");
    const token = createReviewActionToken({ tenantId: tenant.id, itemId: item.id, resolution: "spam", userId: user.id });

    const [body, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), r: "approved" })).toString("base64url");
    expect(() => verifyReviewActionToken(`${forged}.${mac}`)).toThrow(ReviewActionError);
    expect(() => verifyReviewActionToken(token, new Date(Date.now() + 8 * 24 * 3600_000))).toThrow(/expired/);

    await prisma.membership.update({ where: { id: membership.id }, data: { permissions: ["reviews:read"] } });
    const res = await buildServer({ logger: false }).inject({ method: "POST", url: "/api/v1/review-actions", payload: { token } });
    expect(res.statusCode).toBe(403);
    expect((await prisma.humanReviewItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("open");
  });
});
