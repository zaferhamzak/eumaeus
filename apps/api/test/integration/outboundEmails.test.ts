import { beforeEach, describe, expect, it, vi } from "vitest";

// A fake SMTP transport: the next send succeeds, or fails with `failNext`.
const transport = { failNext: null as Error | null, sent: [] as unknown[] };
vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: async (message: unknown) => {
        if (transport.failNext) {
          const error = transport.failNext;
          transport.failNext = null;
          throw error;
        }
        transport.sent.push(message);
        return { messageId: `<m${transport.sent.length}@smtp.test>`, accepted: [], rejected: [] };
      },
    }),
  },
}));

const { prisma } = await import("../../src/db/client.js");
const { buildServer } = await import("../../src/api/server.js");
const { sendEmail, sendMailMessage } = await import("../../src/modules/email/mailer.js");
const { updateSystemSettings } = await import("../../src/modules/settings/systemSettings.js");
const { purgeOldOutboundEmails, recipientsOf } = await import("../../src/modules/email/outboundLog.js");
const { createTestTenantAndMailbox, resetDatabase } = await import("../helpers/db.js");
const { createTestMembership, createTestUser } = await import("../helpers/auth.js");
const { buildTestServer } = await import("../api/helpers/buildTestServer.js");

const message = { subject: "Hello", html: "<p>secret body</p>", text: "secret body" };

/** 1.2 (F): every outgoing email is logged — who, what, sent or failed — never the body. */
describe("outgoing email log", () => {
  beforeEach(async () => {
    await resetDatabase();
    transport.failNext = null;
    transport.sent = [];
    await updateSystemSettings({ smtpHost: "smtp.test.invalid", smtpPort: 465, smtpSecure: true, smtpFromAddress: "eumaeus@x.test" }, "test");
  });

  it("records a successful send with its kind, organization, recipient and message id", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    await sendEmail({ to: "a@x.test", ...message, meta: { kind: "alert", tenantId: tenant.id, relatedId: "alert-1" } });
    const rows = await prisma.outboundEmail.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: tenant.id, kind: "alert", toAddress: "a@x.test", subject: "Hello", status: "sent", error: null, messageId: "<m1@smtp.test>", relatedId: "alert-1" });
    expect(JSON.stringify(rows[0])).not.toContain("secret body");
  });

  it("records a failed send with the error, and the caller still gets the error", async () => {
    transport.failNext = Object.assign(new Error("550 mailbox unavailable"), { responseCode: 550 });
    await expect(sendEmail({ to: "gone@x.test", ...message, meta: { kind: "worker" } })).rejects.toThrow("550");
    expect(await prisma.outboundEmail.findFirstOrThrow()).toMatchObject({ tenantId: null, kind: "worker", status: "failed", error: "550 mailbox unavailable", messageId: null });
  });

  it("channel sends through sendMailMessage are logged too; without a label they count as 'other'", async () => {
    await sendMailMessage({ from: "a@x.test", to: [{ name: "B", address: "b@x.test" }], cc: "c@x.test", subject: "Fwd: hi", text: "x" }, { kind: "forward", relatedId: "email-1" });
    await sendMailMessage({ from: "a@x.test", to: "d@x.test", subject: "raw", text: "x" });
    const rows = await prisma.outboundEmail.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.kind, r.toAddress])).toEqual([
      ["forward", "b@x.test, c@x.test"],
      ["other", "d@x.test"],
    ]);
    expect(recipientsOf({ to: ["x@y.test", { name: "Z", address: "z@y.test" }], bcc: "hidden@y.test" })).toBe("x@y.test, z@y.test, hidden@y.test");
  });

  it("keeps 90 days", async () => {
    const now = new Date("2026-09-29T12:00:00Z");
    await prisma.outboundEmail.createMany({
      data: [
        { kind: "alert", toAddress: "a", subject: "old", status: "sent", createdAt: new Date(now.getTime() - 91 * 86_400_000) },
        { kind: "alert", toAddress: "a", subject: "recent", status: "sent", createdAt: new Date(now.getTime() - 89 * 86_400_000) },
      ],
    });
    expect(await purgeOldOutboundEmails(now)).toBe(1);
    expect((await prisma.outboundEmail.findMany()).map((r) => r.subject)).toEqual(["recent"]);
  });

  it("API: an organization sees only its own sends (audit:read); the system administrator sees all, system emails included", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const other = await prisma.tenant.create({ data: { name: "Other" } });
    await prisma.outboundEmail.createMany({
      data: [
        { tenantId: tenant.id, kind: "alert", toAddress: "a@x.test", subject: "mine ok", status: "sent" },
        { tenantId: tenant.id, kind: "forward", toAddress: "b@x.test", subject: "mine failed", status: "failed", error: "550" },
        { tenantId: other.id, kind: "alert", toAddress: "c@x.test", subject: "theirs", status: "sent" },
        { tenantId: null, kind: "worker", toAddress: "ops@x.test", subject: "system", status: "sent" },
      ],
    });
    const headers = { "x-organization-id": tenant.id };

    const reader = await createTestUser({ email: "reader@x.test" });
    await createTestMembership(reader.id, tenant.id, ["audit:read"]);
    const asReader = buildServer({ logger: false, authResolver: async () => ({ id: reader.id, email: reader.email, isSuperAdmin: false }) });
    const mine = await asReader.inject({ method: "GET", url: "/api/v1/outbound-emails", headers });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().data.map((r: { subject: string }) => r.subject).sort()).toEqual(["mine failed", "mine ok"]);
    const failedOnly = await asReader.inject({ method: "GET", url: "/api/v1/outbound-emails?status=failed", headers });
    expect(failedOnly.json().data).toMatchObject([{ subject: "mine failed", error: "550" }]);
    expect((await asReader.inject({ method: "GET", url: "/api/v1/admin/outbound-emails" })).statusCode).toBe(403);

    const noAudit = await createTestUser({ email: "noaudit@x.test" });
    await createTestMembership(noAudit.id, tenant.id, ["emails:read"]);
    const asNoAudit = buildServer({ logger: false, authResolver: async () => ({ id: noAudit.id, email: noAudit.email, isSuperAdmin: false }) });
    expect((await asNoAudit.inject({ method: "GET", url: "/api/v1/outbound-emails", headers })).statusCode).toBe(403);

    const admin = buildTestServer(tenant.id);
    const all = await admin.inject({ method: "GET", url: "/api/v1/admin/outbound-emails" });
    expect(all.json().data).toHaveLength(4);
    expect(all.json().data.find((r: { subject: string }) => r.subject === "system").organization).toBeNull();
    expect(all.json().data.find((r: { subject: string }) => r.subject === "theirs").organization).toEqual({ id: other.id, name: "Other" });
    const onlyOther = await admin.inject({ method: "GET", url: `/api/v1/admin/outbound-emails?organizationId=${other.id}` });
    expect(onlyOther.json().data.map((r: { subject: string }) => r.subject)).toEqual(["theirs"]);
  });
});
