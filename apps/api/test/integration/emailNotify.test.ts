import { beforeEach, describe, expect, it, vi } from "vitest";
import type Mail from "nodemailer/lib/mailer/index.js";

// The SMTP transport behind sendMailMessage (used by the "send me a test" path).
const smtp: { sent: Mail.Options[] } = { sent: [] };
vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: async (message: Mail.Options) => {
        smtp.sent.push(message);
        return { messageId: `<t${smtp.sent.length}@smtp.test>`, accepted: [], rejected: [] };
      },
    }),
  },
}));

const { prisma } = await import("../../src/db/client.js");
const { updateSystemSettings } = await import("../../src/modules/settings/systemSettings.js");
const { createDestination, createDestinationChannel, updateDestinationChannel, disableDestinationChannel } = await import("../../src/modules/destinations/manageDestinations.js");
const { createEmailNotifyExecutor, runNotifyFlush, resolveNotifyRecipients } = await import("../../src/modules/destinations/notify.js");
const { createReceivedEmail, createSuccessfulAnalysis, createTestTenantAndMailbox, defaultAnswers, resetDatabase } = await import("../helpers/db.js");
const { createTestMembership, createTestUser } = await import("../helpers/auth.js");
const { buildTestServer } = await import("../api/helpers/buildTestServer.js");

type Sent = { message: Mail.Options; meta: unknown };
let sent: Sent[] = [];
const send = async (message: Mail.Options, meta?: unknown) => {
  sent.push({ message, meta });
  return { messageId: `<n${sent.length}@test>`, accepted: [], rejected: [] };
};
const executor = createEmailNotifyExecutor(send);

async function setup() {
  const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
  const alice = await createTestUser({ email: "alice@team.test" });
  const bora = await createTestUser({ email: "bora@team.test" });
  await prisma.user.update({ where: { id: bora.id }, data: { locale: "tr" } });
  await createTestMembership(alice.id, tenant.id, ["reviews:resolve", "emails:read"]);
  await createTestMembership(bora.id, tenant.id, ["emails:read"]);
  const destination = await createDestination(tenant.id, { name: "Faturalar" });
  return { tenant, mailboxConnection, alice, bora, destination };
}

async function analyzedEmail(tenantId: string, mailboxId: string, uid: string, overrides: { subject?: string; textBody?: string; fromAddress?: string } = {}) {
  const email = await createReceivedEmail(tenantId, mailboxId, uid, overrides);
  await createSuccessfulAnalysis(tenantId, email.id, defaultAnswers());
  return email;
}

function ctx(tenantId: string, channel: { id: string; destinationId: string; config: unknown }, email: { id: string; mailboxConnectionId: string }, key = `k-${email.id}`) {
  return {
    tenantId,
    email: { id: email.id, mailboxConnectionId: email.mailboxConnectionId, externalId: "1", uidValidity: 1, subject: "", fromAddress: "", toAddresses: [] },
    routing: { destinationRef: "Faturalar" },
    channel: { id: channel.id, type: "email_notify", config: channel.config, destinationId: channel.destinationId },
    idempotencyKey: key,
  };
}

/** 1.2 (O): a rule sends an email to a destination — its "email_notify" channel tells people. */
describe("rule notification emails", () => {
  beforeEach(async () => {
    await resetDatabase();
    sent = [];
    smtp.sent = [];
    await updateSystemSettings({ smtpHost: "smtp.test.invalid", smtpPort: 465, smtpSecure: true, smtpFromAddress: "eumaeus@x.test", appBaseUrl: "https://app.test" }, "test");
  });

  it("validates settings when saved: someone to notify, real permissions, members of this organization, delivery options", async () => {
    const { tenant, destination } = await setup();
    const save = (config: object) => createDestinationChannel(tenant.id, destination.id, { type: "email_notify", config: config as never });
    const errorsOf = async (config: object) => {
      try {
        await save(config);
        return [];
      } catch (e) {
        return (e as { errors: string[] }).errors;
      }
    };
    expect(await errorsOf({})).toEqual([expect.stringContaining("needs someone to notify")]);
    expect(await errorsOf({ permission: "reviews:everything" })).toEqual(expect.arrayContaining([expect.stringContaining("permission names")]));
    expect(await errorsOf({ members: ["11111111-1111-1111-1111-111111111111"] })).toEqual([expect.stringContaining("not an active member")]);
    expect(await errorsOf({ permission: "reviews:resolve", throttleMinutes: 30 })).toEqual([expect.stringContaining('only applies to delivery "throttle"')]);
    expect(await errorsOf({ permission: "reviews:resolve", delivery: "throttle", throttleMinutes: 5 })).toEqual([expect.stringContaining("from 15 to 1440")]);
    const ok = await save({ addresses: [" Boss@Outside.TEST "], delivery: "digest" });
    expect(ok.config).toEqual({ addresses: ["boss@outside.test"], delivery: "digest" });
  });

  it("reaches picked members, everyone holding a permission, and confirmed outside addresses — never watched mailboxes", async () => {
    const { tenant, mailboxConnection, alice, bora } = await setup();
    const carol = await createTestUser({ email: "carol@team.test", status: "disabled" });
    await createTestMembership(carol.id, tenant.id, ["reviews:resolve"]);
    const watched = await createTestUser({ email: mailboxConnection.emailAddress });
    await createTestMembership(watched.id, tenant.id, ["reviews:resolve"]);
    await prisma.forwardRecipient.createMany({
      data: [
        { tenantId: tenant.id, address: "ok@outside.test", status: "verified" },
        { tenantId: tenant.id, address: "pending@outside.test", status: "pending" },
      ],
    });

    const { recipients, skipped } = await resolveNotifyRecipients(tenant.id, { members: [bora.id], permission: "reviews:resolve", addresses: ["ok@outside.test", "pending@outside.test"] });
    expect(recipients.map((r) => `${r.address}/${r.locale}`).sort()).toEqual(["alice@team.test/en", "bora@team.test/tr", "ok@outside.test/en"]);
    expect(skipped).toEqual(expect.arrayContaining([{ address: mailboxConnection.emailAddress, reason: "monitored_mailbox" }, { address: "pending@outside.test", reason: "unverified" }]));
    expect(alice.id).toBeTruthy();
  });

  it("each: one notice right away — subject from the template, details, a link; one message per language, several people in Bcc", async () => {
    const { tenant, mailboxConnection, alice, bora, destination } = await setup();
    const third = await createTestUser({ email: "cem@team.test" });
    await createTestMembership(third.id, tenant.id, ["emails:read"]);
    const channel = await createDestinationChannel(tenant.id, destination.id, { type: "email_notify", config: { members: [alice.id, bora.id, third.id], subjectTemplate: "[{category}] {subject} — {sender}" } });
    const email = await analyzedEmail(tenant.id, mailboxConnection.id, "1", { subject: "Invoice 7", fromAddress: "billing@vendor.test", textBody: "Please pay by Friday." });

    const outcome = await executor.execute(ctx(tenant.id, channel, email));
    expect(outcome).toMatchObject({ status: "succeeded", responseMetadata: { sent: true, notified: 3 } });
    expect(sent).toHaveLength(2);
    const en = sent.find((s) => (s.message.bcc as string[] | undefined)?.includes("alice@team.test"))!;
    expect(en.message.bcc).toEqual(["alice@team.test", "cem@team.test"]);
    expect(en.message.to).toEqual({ name: "Eumaeus", address: "eumaeus@x.test" });
    expect(en.message.subject).toBe("[business_opportunity] Invoice 7 — billing@vendor.test");
    expect(en.message.html).toContain(`https://app.test/emails/${email.id}`);
    expect(en.message.html).not.toContain("Please pay by Friday"); // no excerpt unless asked
    expect(en.meta).toMatchObject({ kind: "rule_notify", tenantId: tenant.id, relatedId: email.id });
    const tr = sent.find((s) => s.message.to === "bora@team.test")!;
    expect(tr.message.html).toContain("Kural bildirimi");
    expect(await prisma.notifyChannelState.findUnique({ where: { destinationChannelId: channel.id } })).not.toBeNull();
  });

  it("includes the first lines only when asked, and never notifies about a copy Eumaeus sent itself", async () => {
    const { tenant, mailboxConnection, alice, destination } = await setup();
    const channel = await createDestinationChannel(tenant.id, destination.id, { type: "email_notify", config: { members: [alice.id], includeExcerpt: true } });
    const email = await analyzedEmail(tenant.id, mailboxConnection.id, "1", { textBody: "Please pay by Friday." });
    await executor.execute(ctx(tenant.id, channel, email));
    expect(sent[0]!.message.html).toContain("Please pay by Friday.");

    // An HTML-only email gets its excerpt from the HTML.
    const htmlOnly = await analyzedEmail(tenant.id, mailboxConnection.id, "3");
    await prisma.email.update({ where: { id: htmlOnly.id }, data: { textBody: null, htmlBody: "<style>p{}</style><p>Your <b>order</b> shipped &amp; is on its way.</p>" } });
    await executor.execute(ctx(tenant.id, channel, htmlOnly));
    expect(sent[1]!.message.html).toContain("Your order shipped &amp; is on its way.");

    const copy = await analyzedEmail(tenant.id, mailboxConnection.id, "2");
    await prisma.email.update({ where: { id: copy.id }, data: { forwardedByEumaeus: true } });
    expect(await executor.execute(ctx(tenant.id, channel, copy))).toMatchObject({ status: "failed", retryable: false, errorClass: "loop_detected" });
  });

  it("throttle: the first goes at once, the rest wait and go together when the window has passed", async () => {
    const { tenant, mailboxConnection, alice, destination } = await setup();
    const channel = await createDestinationChannel(tenant.id, destination.id, { type: "email_notify", config: { members: [alice.id], delivery: "throttle", throttleMinutes: 30 } });
    const e1 = await analyzedEmail(tenant.id, mailboxConnection.id, "1", { subject: "First" });
    const e2 = await analyzedEmail(tenant.id, mailboxConnection.id, "2", { subject: "Second" });
    const e3 = await analyzedEmail(tenant.id, mailboxConnection.id, "3", { subject: "Third" });

    await executor.execute(ctx(tenant.id, channel, e1));
    expect(await executor.execute(ctx(tenant.id, channel, e2))).toMatchObject({ status: "succeeded", responseMetadata: { queued: true } });
    await executor.execute(ctx(tenant.id, channel, e3));
    expect(sent).toHaveLength(1);

    expect(await runNotifyFlush(new Date(Date.now() + 10 * 60_000), send)).toEqual([]);
    const flushed = await runNotifyFlush(new Date(Date.now() + 31 * 60_000), send);
    expect(flushed).toEqual([{ channelId: channel.id, emails: 2, outcome: "succeeded" }]);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.message.subject).toBe("Faturalar: 2 new emails");
    expect(sent[1]!.message.html).toContain("Second");
    expect(sent[1]!.message.html).toContain("Third");
    expect(await prisma.notifyQueueItem.count()).toBe(0);
  });

  it("digest: everything waits for the summary; a long list says how many more", async () => {
    const { tenant, mailboxConnection, alice, destination } = await setup();
    const channel = await createDestinationChannel(tenant.id, destination.id, { type: "email_notify", config: { members: [alice.id], delivery: "digest", digestIntervalMinutes: 60 } });
    for (let i = 1; i <= 23; i++) {
      const e = await analyzedEmail(tenant.id, mailboxConnection.id, String(i), { subject: `Mail ${i}` });
      await executor.execute(ctx(tenant.id, channel, e));
    }
    expect(sent).toHaveLength(0);
    await runNotifyFlush(new Date(Date.now() + 61 * 60_000), send);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message.subject).toBe("Faturalar: 23 new emails");
    expect(sent[0]!.message.html).toContain("…and 3 more");
    expect(sent[0]!.meta).toMatchObject({ relatedId: channel.id });
  });

  it("editing the channel keeps its queue; a disabled channel's queue is dropped", async () => {
    const { tenant, mailboxConnection, alice, destination } = await setup();
    const channel = await createDestinationChannel(tenant.id, destination.id, { type: "email_notify", config: { members: [alice.id], delivery: "digest" } });
    const e = await analyzedEmail(tenant.id, mailboxConnection.id, "1");
    await executor.execute(ctx(tenant.id, channel, e));
    const edited = await updateDestinationChannel(channel.id, { type: "email_notify", config: { members: [alice.id], delivery: "digest", digestIntervalMinutes: 120 } });
    expect(await prisma.notifyQueueItem.findMany({ select: { destinationChannelId: true } })).toEqual([{ destinationChannelId: edited.id }]);

    await disableDestinationChannel(edited.id);
    expect(await runNotifyFlush(new Date(Date.now() + 999 * 60_000), send)).toEqual([{ channelId: edited.id, emails: 0, outcome: "dropped" }]);
    expect(sent).toHaveLength(0);
  });

  it("stops at the organization's daily outgoing limit and when nobody can be reached", async () => {
    const { tenant, mailboxConnection, alice, destination } = await setup();
    await prisma.tenant.update({ where: { id: tenant.id }, data: { forwardDailyLimit: 1 } });
    await prisma.outboundEmail.create({ data: { tenantId: tenant.id, kind: "rule_notify", toAddress: "x", subject: "earlier", status: "sent" } });
    const channel = await createDestinationChannel(tenant.id, destination.id, { type: "email_notify", config: { members: [alice.id] } });
    const e = await analyzedEmail(tenant.id, mailboxConnection.id, "1");
    expect(await executor.execute(ctx(tenant.id, channel, e))).toMatchObject({ status: "failed", errorClass: "rate_limited" });

    await prisma.membership.updateMany({ where: { userId: alice.id }, data: { status: "revoked" } });
    expect(await executor.execute(ctx(tenant.id, channel, e, "k2"))).toMatchObject({ status: "failed", errorClass: "no_deliverable_recipients" });
  });

  it("API: preview renders a real email (logo inline); 'send me a test' goes to the signed-in person only; outside addresses get a confirmation", async () => {
    const { tenant, mailboxConnection, alice } = await setup();
    const email = await analyzedEmail(tenant.id, mailboxConnection.id, "1", { subject: "Real subject" });
    const app = buildTestServer(tenant.id);

    const preview = await app.inject({ method: "POST", url: "/api/v1/destinations/notify-preview", payload: { config: { members: [alice.id] }, destinationName: "Faturalar" } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ emailId: email.id, subject: "Faturalar: Real subject" });
    expect(preview.json().html).toContain("data:image/png;base64,");
    expect((await app.inject({ method: "POST", url: "/api/v1/destinations/notify-preview", payload: { config: {} } })).statusCode).toBe(400);

    const test = await app.inject({ method: "POST", url: "/api/v1/destinations/notify-test", payload: { config: { members: [alice.id], addresses: ["someone@outside.test"] }, destinationName: "Faturalar" } });
    expect(test.json()).toMatchObject({ sent: true });
    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0]!.to).toBe(test.json().to);
    expect(smtp.sent[0]!.bcc).toBeUndefined();

    smtp.sent = [];
    const created = await app.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "Notify", channels: [{ type: "email_notify", config: { addresses: ["boss@outside.test"] } }] } });
    expect(created.statusCode).toBe(201);
    expect(await prisma.forwardRecipient.findFirst({ where: { address: "boss@outside.test" } })).toMatchObject({ status: "pending" });
    expect(smtp.sent.map((m) => m.to)).toEqual(["boss@outside.test"]);
  });
});
