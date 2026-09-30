import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: Array<{ to: string; subject: string; html: string; text: string }> = [];
let mailerConfigured = true;

vi.mock("../../src/modules/email/mailer.js", () => ({
  isMailerConfigured: async () => mailerConfigured,
  sendEmail: async (input: { to: string; subject: string; html: string; text: string }) => {
    sent.push(input);
  },
}));

const { runReviewDigests } = await import("../../src/modules/review/reviewDigest.js");
const { prisma } = await import("../../src/db/client.js");
const { resetDatabase, createTestTenantAndMailbox, createReceivedEmail } = await import("../helpers/db.js");
const { createTestUser, createTestMembership } = await import("../helpers/auth.js");

async function openReviewItem(tenantId: string, mailboxId: string, externalId: string, subject: string, createdAt: Date) {
  const email = await createReceivedEmail(tenantId, mailboxId, externalId);
  await prisma.email.update({ where: { id: email.id }, data: { subject } });
  return prisma.humanReviewItem.create({ data: { tenantId, emailId: email.id, reason: "unmatched", status: "open", createdAt } });
}

describe("runReviewDigests", () => {
  beforeEach(async () => {
    await resetDatabase();
    sent.length = 0;
    mailerConfigured = true;
  });

  it("emails each active member who can see reviews, once, summarizing items since the last digest", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const lastDigest = new Date(Date.now() - 2 * 60 * 60_000);
    await prisma.tenant.update({ where: { id: tenant.id }, data: { reviewDigestEnabled: true, reviewDigestIntervalMinutes: 60, lastReviewDigestAt: lastDigest } });

    const reviewer = await createTestUser({ email: "reviewer@example.com" });
    await createTestMembership(reviewer.id, tenant.id, ["reviews:resolve"]);
    const noReviewPermission = await createTestUser({ email: "rules-only@example.com" });
    await createTestMembership(noReviewPermission.id, tenant.id, ["rules:read"]);
    const pending = await createTestUser({ email: "pending@example.com" });
    await createTestMembership(pending.id, tenant.id, ["reviews:read"], "pending");

    await openReviewItem(tenant.id, mailboxConnection.id, "1", "Before the window", new Date(lastDigest.getTime() - 60_000));
    await openReviewItem(tenant.id, mailboxConnection.id, "2", "Invoice <script>", new Date(Date.now() - 30 * 60_000));
    await openReviewItem(tenant.id, mailboxConnection.id, "3", "Partnership", new Date(Date.now() - 10 * 60_000));

    const results = await runReviewDigests();

    expect(results).toEqual([{ organizationId: tenant.id, newItems: 2, recipients: 1, sent: 1 }]);
    expect(sent.map((m) => m.to)).toEqual(["reviewer@example.com"]);
    expect(sent[0]?.subject).toContain("2 new emails");
    expect(sent[0]?.text).toContain("Partnership");
    expect(sent[0]?.text).not.toContain("Before the window");
    expect(sent[0]?.html).not.toContain("<script>");

    const refreshed = await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    expect(refreshed.lastReviewDigestAt!.getTime()).toBeGreaterThan(lastDigest.getTime());
  });

  it("skips an organization whose interval hasn't elapsed yet", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { reviewDigestEnabled: true, reviewDigestIntervalMinutes: 60, lastReviewDigestAt: new Date(Date.now() - 10 * 60_000) },
    });
    const reviewer = await createTestUser();
    await createTestMembership(reviewer.id, tenant.id, ["reviews:read"]);
    await openReviewItem(tenant.id, mailboxConnection.id, "1", "x", new Date());

    expect(await runReviewDigests()).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("does nothing for organizations with digests disabled (the default)", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const reviewer = await createTestUser();
    await createTestMembership(reviewer.id, tenant.id, ["reviews:read"]);
    await openReviewItem(tenant.id, mailboxConnection.id, "1", "x", new Date());
    expect(await runReviewDigests()).toEqual([]);
  });

  it("with SMTP unconfigured, sends nothing AND does not advance the window — nothing is silently dropped", async () => {
    mailerConfigured = false;
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const lastDigest = new Date(Date.now() - 2 * 60 * 60_000);
    await prisma.tenant.update({ where: { id: tenant.id }, data: { reviewDigestEnabled: true, lastReviewDigestAt: lastDigest } });
    await openReviewItem(tenant.id, mailboxConnection.id, "1", "x", new Date());

    expect(await runReviewDigests()).toEqual([]);
    const refreshed = await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    expect(refreshed.lastReviewDigestAt?.getTime()).toBe(lastDigest.getTime());
  });

  it("no new items: sends nothing, but still advances the window", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    await prisma.tenant.update({ where: { id: tenant.id }, data: { reviewDigestEnabled: true, lastReviewDigestAt: new Date(Date.now() - 2 * 60 * 60_000) } });
    const results = await runReviewDigests();
    expect(results).toEqual([{ organizationId: tenant.id, newItems: 0, recipients: 0, sent: 0 }]);
    expect(sent).toHaveLength(0);
  });
});
