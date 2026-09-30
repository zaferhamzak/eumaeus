import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: Array<{ to: string; subject: string; text: string }> = [];
let mailerConfigured = true;

vi.mock("../../src/modules/email/mailer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/modules/email/mailer.js")>()),
  isMailerConfigured: async () => mailerConfigured,
  sendEmail: async (input: { to: string; subject: string; html: string; text: string }) => {
    sent.push(input);
  },
}));

const { buildTestServer } = await import("./helpers/buildTestServer.js");
const { createTestTenantAndMailbox, resetDatabase } = await import("../helpers/db.js");
const { prisma } = await import("../../src/db/client.js");

const FORWARD = { type: "forward", config: { mode: "attachment", to: ["Team@Acme.test"], cc: ["boss@acme.test"] } };

function tokenFrom(text: string): string {
  const match = /token=([^\s&]+)/.exec(text);
  if (!match?.[1]) throw new Error("no token in email");
  return decodeURIComponent(match[1]);
}

describe("forward channels and recipient verification", () => {
  beforeEach(async () => {
    await resetDatabase();
    sent.length = 0;
    mailerConfigured = true;
  });

  it("saving a forward channel normalizes addresses and emails each new recipient a confirmation link", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);

    const res = await app.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "Marketing", channels: [FORWARD] } });

    expect(res.statusCode).toBe(201);
    expect(res.json().channels[0].config.to).toEqual(["team@acme.test"]);
    expect(sent.map((m) => m.to).sort()).toEqual(["boss@acme.test", "team@acme.test"]);
    const list = await app.inject({ method: "GET", url: "/api/v1/forward-recipients" });
    expect(list.json().data.map((r: { status: string }) => r.status)).toEqual(["pending", "pending"]);
  });

  it("the emailed link verifies the recipient, once", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    await app.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "Marketing", channels: [FORWARD] } });
    const token = tokenFrom(sent.find((m) => m.to === "team@acme.test")!.text);

    const ok = await app.inject({ method: "POST", url: "/api/v1/forward-recipients/verify", payload: { token } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ address: "team@acme.test", organizationName: "Test Tenant" });
    expect((await prisma.forwardRecipient.findFirstOrThrow({ where: { address: "team@acme.test" } })).status).toBe("verified");

    const again = await app.inject({ method: "POST", url: "/api/v1/forward-recipients/verify", payload: { token } });
    expect(again.statusCode).toBe(400);
  });

  it("an expired link is rejected", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    await app.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "Marketing", channels: [FORWARD] } });
    const token = tokenFrom(sent[0]!.text);
    await prisma.forwardRecipient.updateMany({ data: { tokenExpiresAt: new Date(Date.now() - 1000) } });

    const res = await app.inject({ method: "POST", url: "/api/v1/forward-recipients/verify", payload: { token } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("expired");
  });

  it("re-saving a channel doesn't re-send while a link is still live; resend issues a new one; revoke stops it", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const created = (await app.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "Marketing", channels: [FORWARD] } })).json();
    sent.length = 0;

    await app.inject({ method: "PATCH", url: `/api/v1/destinations/${created.id}/channels/${created.channels[0].id}`, payload: { config: { ...FORWARD.config, fromName: "Bot" } } });
    expect(sent).toHaveLength(0);

    const recipient = await prisma.forwardRecipient.findFirstOrThrow({ where: { address: "team@acme.test" } });
    const resend = await app.inject({ method: "POST", url: `/api/v1/forward-recipients/${recipient.id}/resend` });
    expect(resend.json().emailSent).toBe(true);
    expect(sent).toHaveLength(1);

    const revoke = await app.inject({ method: "DELETE", url: `/api/v1/forward-recipients/${recipient.id}` });
    expect(revoke.json().status).toBe("revoked");
  });

  it("without SMTP, recipients are registered as pending and the channel still saves", async () => {
    mailerConfigured = false;
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "Marketing", channels: [FORWARD] } });
    expect(res.statusCode).toBe(201);
    expect(sent).toHaveLength(0);
    expect(await prisma.forwardRecipient.count({ where: { status: "pending" } })).toBe(2);
  });

  it.each([
    [{ mode: "bounce", to: ["a@acme.test"] }, "mode"],
    [{ mode: "attachment", to: [] }, "to"],
    [{ mode: "attachment", to: ["not-an-email"] }, "invalid email"],
    [{ mode: "attachment", to: ["a@acme.test"], cc: ["a@acme.test"] }, "more than once"],
    [{ mode: "attachment", to: ["a@acme.test"], subjectTemplate: "x\r\nBcc: y" }, "subjectTemplate"],
    [{ mode: "attachment", to: ["a@acme.test"], surprise: true }, "unknown setting"],
    [{ mode: "redirect", delivery: "digest", to: ["a@acme.test"] }, "cannot combine"],
    [{ mode: "attachment", delivery: "weekly", to: ["a@acme.test"] }, "delivery"],
    [{ mode: "attachment", delivery: "digest", digestIntervalMinutes: 5, to: ["a@acme.test"] }, "digestIntervalMinutes"],
  ])("rejects an invalid forward config %j", async (config, message) => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "Marketing", channels: [{ type: "forward", config }] } });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain(message);
  });

  it("rejects forwarding to a monitored mailbox or a domain outside the allowlist", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);

    const loop = await app.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "Loop", channels: [{ type: "forward", config: { mode: "inline", to: ["bob@eumaeus.test"] } }] } });
    expect(loop.statusCode).toBe(400);
    expect(JSON.stringify(loop.json())).toContain("would loop");

    const settings = await app.inject({ method: "PATCH", url: `/api/v1/organizations/${tenant.id}`, payload: { forwardAllowedDomains: ["@Partner.test"], forwardDailyLimit: 50 } });
    expect(settings.json()).toMatchObject({ forwardAllowedDomains: ["partner.test"], forwardDailyLimit: 50 });

    const outside = await app.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "Out", channels: [FORWARD] } });
    expect(outside.statusCode).toBe(400);
    expect(JSON.stringify(outside.json())).toContain("allowlist");
  });

  it("a digest channel reports its queued emails on the destination detail", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const created = (
      await app.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "Digest", channels: [{ type: "forward", config: { mode: "attachment", delivery: "digest", digestIntervalMinutes: 1440, to: ["team@acme.test"] } }] } })
    ).json();
    const channelId = created.channels[0].id;
    expect(created.channels[0].config).toMatchObject({ delivery: "digest", digestIntervalMinutes: 1440 });

    const { createReceivedEmail } = await import("../helpers/db.js");
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
    await prisma.forwardDigestItem.create({ data: { tenantId: tenant.id, destinationChannelId: channelId, emailId: email.id } });

    const detail = await app.inject({ method: "GET", url: `/api/v1/destinations/${created.id}` });
    expect(detail.json().channels[0].digest).toEqual({ pending: 1, lastSentAt: null });
  });

  it("an invalid channel rejects the whole request: no empty destination is left behind (0.13.1)", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "Half", channels: [{ type: "forward", config: { mode: "bounce", to: ["a@acme.test"] } }] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).not.toContain("was created");
    expect(await prisma.destination.count({ where: { name: "Half" } })).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("rejects an invalid allowlist domain", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "PATCH", url: `/api/v1/organizations/${tenant.id}`, payload: { forwardAllowedDomains: ["not a domain"] } });
    expect(res.statusCode).toBe(400);
  });
});
