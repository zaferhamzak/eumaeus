import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { applyRetention, eraseSender } from "../../src/modules/privacy/retention.js";
import { evaluateRulesForEmail } from "../../src/modules/rules/evaluateRulesForEmail.js";
import { buildTestServer } from "../api/helpers/buildTestServer.js";
import { buildServer } from "../../src/api/server.js";
import { createTestMembership, createTestUser } from "../helpers/auth.js";
import { createReceivedEmail, createSuccessfulAnalysis, createTestTenantAndMailbox, defaultAnswers, resetDatabase } from "../helpers/db.js";

const DAY = 24 * 60 * 60 * 1000;

async function processedEmail(tenantId: string, mailboxId: string, uid: string, daysAgo: number, fromAddress = "alice@example.com") {
  const email = await createReceivedEmail(tenantId, mailboxId, uid, { fromAddress, textBody: `secret body ${uid}` });
  await prisma.email.update({ where: { id: email.id }, data: { receivedAt: new Date(Date.now() - daysAgo * DAY), htmlBody: "<p>secret</p>" } });
  await prisma.emailSource.create({ data: { tenantId, emailId: email.id, source: Buffer.from("raw"), sizeBytes: 3, expiresAt: new Date(Date.now() + 30 * DAY) } });
  await createSuccessfulAnalysis(tenantId, email.id, defaultAnswers());
  await evaluateRulesForEmail(email.id);
  await prisma.auditEvent.create({ data: { tenantId, emailId: email.id, eventType: "test_event", actor: "system", payload: { subject: "secret subject" } } });
  return email;
}

describe("Phase 20 — retention and sender erasure", () => {
  beforeEach(resetDatabase);

  it("removes bodies after bodyRetentionDays and whole emails after emailRetentionDays, keeping id-only audit", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const fresh = await processedEmail(tenant.id, mailboxConnection.id, "1", 1);
    const middle = await processedEmail(tenant.id, mailboxConnection.id, "2", 10);
    const old = await processedEmail(tenant.id, mailboxConnection.id, "3", 40);
    await prisma.tenant.update({ where: { id: tenant.id }, data: { bodyRetentionDays: 7, emailRetentionDays: 30 } });

    expect(await applyRetention()).toEqual({ bodiesPurged: 1, emailsDeleted: 1 });

    const f = await prisma.email.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(f.textBody).toContain("secret body");
    const m = await prisma.email.findUniqueOrThrow({ where: { id: middle.id } });
    expect(m).toMatchObject({ textBody: null, htmlBody: null, subject: "Test" });
    expect(m.bodyPurgedAt).not.toBeNull();
    expect(await prisma.emailSource.count({ where: { emailId: middle.id } })).toBe(0);
    expect(await prisma.routingDecision.count({ where: { emailId: middle.id } })).toBe(1);

    expect(await prisma.email.count({ where: { id: old.id } })).toBe(0);
    for (const table of [prisma.analysisResult, prisma.routingDecision, prisma.ruleEvaluation, prisma.humanReviewItem] as const) {
      expect(await (table as typeof prisma.routingDecision).count({ where: { emailId: old.id } })).toBe(0);
    }
    const trail = await prisma.auditEvent.findMany({ where: { tenantId: tenant.id, eventType: "test_event", emailId: null } });
    expect(trail).toHaveLength(1);
    expect(trail[0]!.payload).toEqual({ erased: true, emailId: old.id });

    // Idempotent: nothing left to do.
    expect(await applyRetention()).toEqual({ bodiesPurged: 0, emailsDeleted: 0 });

    const detail = (await buildTestServer(tenant.id).inject({ method: "GET", url: `/api/v1/emails/${middle.id}?includeBody=true` })).json();
    expect(detail.bodyPurgedAt).not.toBeNull();
  });

  it("erases one sender (from or Reply-To) with a dry run first; the audit event holds only a hash", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    await processedEmail(tenant.id, mailboxConnection.id, "1", 1, "Ayse@Example.com");
    const replyTo = await processedEmail(tenant.id, mailboxConnection.id, "2", 1, "noreply@shop.test");
    await prisma.email.update({ where: { id: replyTo.id }, data: { replyToAddress: "ayse@example.com" } });
    const other = await processedEmail(tenant.id, mailboxConnection.id, "3", 1, "bob@example.com");
    await prisma.senderListEntry.create({ data: { tenantId: tenant.id, kind: "block", pattern: "ayse@example.com" } });

    const preview = await eraseSender(tenant.id, " AYSE@example.com ", { dryRun: true });
    expect(preview).toMatchObject({ dryRun: true, address: "ayse@example.com", emails: 2, senderListEntries: 1 });
    expect(await prisma.email.count({ where: { tenantId: tenant.id } })).toBe(3);

    const done = await eraseSender(tenant.id, "ayse@example.com", { dryRun: false }, "admin@test");
    expect(done).toMatchObject({ dryRun: false, emails: 2 });
    expect((await prisma.email.findMany({ where: { tenantId: tenant.id } })).map((e) => e.id)).toEqual([other.id]);
    expect(await prisma.senderListEntry.count({ where: { tenantId: tenant.id } })).toBe(1);
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId: tenant.id, eventType: "privacy_sender_erased" } });
    expect(JSON.stringify(event.payload)).not.toContain("ayse");
    expect(event.payload).toMatchObject({ emails: 2, addressSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });

    await expect(eraseSender(tenant.id, "not-an-address", { dryRun: true })).rejects.toThrow(/not an email address/);
  });

  it("API: erase-sender needs privacy:erase and defaults to a dry run; retention settings are validated", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    await processedEmail(tenant.id, mailboxConnection.id, "1", 1, "x@example.com");
    const user = await createTestUser();
    await createTestMembership(user.id, tenant.id, ["emails:read", "audit:read"]);
    const limited = buildServer({ logger: false, authResolver: async () => ({ id: user.id, email: user.email, isSuperAdmin: false }) });
    const headers = { "x-organization-id": tenant.id };
    expect((await limited.inject({ method: "POST", url: "/api/v1/privacy/erase-sender", headers, payload: { address: "x@example.com" } })).statusCode).toBe(403);

    const app = buildTestServer(tenant.id);
    const dry = await app.inject({ method: "POST", url: "/api/v1/privacy/erase-sender", payload: { address: "x@example.com" } });
    expect(dry.json()).toMatchObject({ dryRun: true, emails: 1 });
    expect(await prisma.email.count()).toBe(1);
    expect((await app.inject({ method: "POST", url: "/api/v1/privacy/erase-sender", payload: { address: "nope" } })).statusCode).toBe(400);

    const ok = await app.inject({ method: "PATCH", url: `/api/v1/organizations/${tenant.id}`, payload: { bodyRetentionDays: 30, emailRetentionDays: 365 } });
    expect(ok.json()).toMatchObject({ bodyRetentionDays: 30, emailRetentionDays: 365 });
    expect((await app.inject({ method: "PATCH", url: `/api/v1/organizations/${tenant.id}`, payload: { bodyRetentionDays: 400 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: `/api/v1/organizations/${tenant.id}`, payload: { emailRetentionDays: 0 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: `/api/v1/organizations/${tenant.id}`, payload: { bodyRetentionDays: null, emailRetentionDays: null } })).json()).toMatchObject({ bodyRetentionDays: null, emailRetentionDays: null });
  });
});
