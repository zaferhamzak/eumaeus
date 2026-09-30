import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: Array<{ to: string; subject: string; text: string }> = [];
let failSend = false;
vi.mock("../../src/modules/email/mailer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/modules/email/mailer.js")>()),
  isMailerConfigured: async () => true,
  sendEmail: async (input: { to: string; subject: string; text: string }) => {
    if (failSend) throw new Error("SMTP down");
    sent.push(input);
  },
}));

const { prisma } = await import("../../src/db/client.js");
const { resetDatabase } = await import("../helpers/db.js");
const { assignReviewItem } = await import("../../src/modules/review/reviewTeamwork.js");
const { notifyPendingAssignments } = await import("../../src/modules/review/assignmentNotify.js");

let tenantId: string;
let reviewerId: string;
let mailboxId: string;
let n = 0;

async function item(subject = "Invoice?") {
  const email = await prisma.email.create({
    data: { tenantId, mailboxConnectionId: mailboxId, provider: "imap", externalId: String(++n), uidValidity: 1, fromAddress: "a@x.com", toAddresses: [], ccAddresses: [], bccAddresses: [], subject, receivedAt: new Date(), state: "awaiting_review", stateUpdatedAt: new Date() },
  });
  return (await prisma.humanReviewItem.create({ data: { tenantId, emailId: email.id, reason: "unmatched" } })).id;
}

beforeEach(async () => {
  await resetDatabase();
  sent.length = 0;
  failSend = false;
  tenantId = (await prisma.tenant.create({ data: { name: "Team Org", assignmentNotifyThreshold: 3 } })).id;
  mailboxId = (await prisma.mailboxConnection.create({ data: { tenantId, name: "In", emailAddress: "in@example.com", provider: "imap", providerConfig: {}, status: "active" } })).id;
  const reviewer = await prisma.user.create({ data: { email: "rev@example.com", passwordHash: "x", locale: "tr" } });
  reviewerId = reviewer.id;
  await prisma.membership.create({ data: { userId: reviewer.id, tenantId, permissions: ["reviews:read", "reviews:resolve"], status: "active" } });
});

describe("assignment emails with a threshold", () => {
  it("waits until the threshold of assigned items, then sends one email listing them all", async () => {
    const ids = [await item("Bir"), await item("İki"), await item("Üç")];
    await assignReviewItem(tenantId, ids[0]!, reviewerId, "boss@example.com");
    await assignReviewItem(tenantId, ids[1]!, reviewerId, "boss@example.com");
    expect(sent).toHaveLength(0);
    await assignReviewItem(tenantId, ids[2]!, reviewerId, "boss@example.com");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("rev@example.com");
    expect(sent[0]!.subject).toBe("Team Org: size kontrol için 3 mail atandı"); // the reviewer's language
    expect(sent[0]!.text).toContain("Bir");
    expect(sent[0]!.text).toContain(`/review/${ids[2]}`);

    // The next batch starts from zero.
    await assignReviewItem(tenantId, await item(), reviewerId, "boss@example.com");
    expect(sent).toHaveLength(1);
  });

  it("items resolved or reassigned before the threshold don't count", async () => {
    const a = await item();
    const b = await item();
    await assignReviewItem(tenantId, a, reviewerId, "boss@example.com");
    await assignReviewItem(tenantId, b, reviewerId, "boss@example.com");
    await prisma.humanReviewItem.update({ where: { id: a }, data: { status: "resolved", resolution: "approved", resolvedAt: new Date() } });
    await assignReviewItem(tenantId, b, null, "boss@example.com");
    await assignReviewItem(tenantId, await item(), reviewerId, "boss@example.com");
    expect(sent).toHaveLength(0);
  });

  it("taking items yourself sends nothing; switched off sends nothing", async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { assignmentNotifyThreshold: 1 } });
    await assignReviewItem(tenantId, await item(), reviewerId, "REV@example.com");
    expect(sent).toHaveLength(0);
    await prisma.tenant.update({ where: { id: tenantId }, data: { assignmentNotifyEnabled: false } });
    await assignReviewItem(tenantId, await item(), reviewerId, "boss@example.com");
    expect(await notifyPendingAssignments()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("a failed send is retried by the periodic pass; a lowered threshold takes effect there too", async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { assignmentNotifyThreshold: 1 } });
    failSend = true;
    await assignReviewItem(tenantId, await item(), reviewerId, "boss@example.com"); // assignment still succeeds
    expect(await prisma.humanReviewItem.count({ where: { assignedTo: reviewerId, assignmentNotifiedAt: null } })).toBe(1);
    failSend = false;
    expect(await notifyPendingAssignments()).toBe(1);
    expect(sent).toHaveLength(1);

    await prisma.tenant.update({ where: { id: tenantId }, data: { assignmentNotifyThreshold: 5 } });
    await assignReviewItem(tenantId, await item(), reviewerId, "boss@example.com");
    await assignReviewItem(tenantId, await item(), reviewerId, "boss@example.com");
    expect(sent).toHaveLength(1);
    await prisma.tenant.update({ where: { id: tenantId }, data: { assignmentNotifyThreshold: 2 } });
    expect(await notifyPendingAssignments()).toBe(1);
    expect(sent).toHaveLength(2);
  });
});
