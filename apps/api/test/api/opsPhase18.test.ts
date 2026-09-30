import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";
import { buildTestServer } from "./helpers/buildTestServer.js";
import { createTestMembership, createTestUser } from "../helpers/auth.js";
import { createReceivedEmail, createSuccessfulAnalysis, createTestTenantAndMailbox, defaultAnswers, resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/db/client.js";
import { evaluateRulesForEmail } from "../../src/modules/rules/evaluateRulesForEmail.js";

describe("Phase 18 API", () => {
  beforeEach(resetDatabase);

  it("reprocess needs emails:reprocess; bulk reports per-email results; preview is read-only", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
    await createSuccessfulAnalysis(tenant.id, email.id, defaultAnswers());
    await evaluateRulesForEmail(email.id);

    const user = await createTestUser();
    await createTestMembership(user.id, tenant.id, ["emails:read", "rules:write"]);
    const limited = buildServer({ logger: false, authResolver: async () => ({ id: user.id, email: user.email, isSuperAdmin: false }) });
    expect((await limited.inject({ method: "POST", url: `/api/v1/emails/${email.id}/reprocess`, headers: { "x-organization-id": tenant.id } })).statusCode).toBe(403);

    const app = buildTestServer(tenant.id);
    const preview = await app.inject({ method: "POST", url: "/api/v1/simulations", payload: { target: { type: "current" }, scope: { emailIds: [email.id] } } });
    expect(preview.json()).toMatchObject({ evaluated: 1, changed: 0 });
    expect(await prisma.routingDecision.count()).toBe(1);

    const bulk = await app.inject({ method: "POST", url: "/api/v1/emails/reprocess", payload: { emailIds: [email.id, "missing"] } });
    expect(bulk.json().results).toEqual([
      expect.objectContaining({ emailId: email.id, status: "reprocessed", decisionStatus: "unmatched" }),
      expect.objectContaining({ emailId: "missing", status: "refused", reason: "not_found" }),
    ]);
    const detail = (await app.inject({ method: "GET", url: `/api/v1/emails/${email.id}` })).json();
    expect(detail.previousRoutingDecisions).toHaveLength(1);
    expect(detail.previousRoutingDecisions[0].supersededAt).not.toBeNull();
  });

  it("lists open alerts and serves reports", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    await prisma.alert.create({ data: { tenantId: tenant.id, kind: "jev_errors", title: "Jev is down", detail: "d" } });
    const app = buildTestServer(tenant.id);
    expect((await app.inject({ method: "GET", url: "/api/v1/alerts" })).json().data).toEqual([expect.objectContaining({ kind: "jev_errors", status: "open", subjectKey: null })]);

    const report = await app.inject({ method: "GET", url: "/api/v1/stats/reports?days=30&tz=Europe/Istanbul" });
    expect(report.statusCode).toBe(200);
    expect(report.json().daily.length).toBeGreaterThanOrEqual(30);
    expect((await app.inject({ method: "GET", url: "/api/v1/stats/reports?days=12" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/stats/reports?tz=Mars/Base" })).statusCode).toBe(400);
  });

  it("the host report sums every active organization and lists each one — superAdmin only", async () => {
    const a = await createTestTenantAndMailbox();
    const b = await createTestTenantAndMailbox();
    await prisma.tenant.update({ where: { id: b.tenant.id }, data: { name: "Beta" } });
    for (const [t, n] of [[a, 2], [b, 1]] as const) {
      for (let i = 0; i < n; i += 1) {
        const email = await createReceivedEmail(t.tenant.id, t.mailboxConnection.id, `${t.tenant.id}-${i}`);
        await createSuccessfulAnalysis(t.tenant.id, email.id, defaultAnswers());
      }
    }
    await prisma.alert.create({ data: { tenantId: b.tenant.id, kind: "jev_errors", title: "t", detail: "d" } });
    const off = await prisma.tenant.create({ data: { name: "Gone", status: "disabled" } });

    const admin = buildServer({ logger: false, authResolver: async () => ({ id: "root", email: "root@test", isSuperAdmin: true }) });
    const res = await admin.inject({ method: "GET", url: "/api/v1/admin/reports?days=7&tz=Europe/Istanbul" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totals.emails).toBe(3);
    expect(body.organizations).toHaveLength(3);
    expect(body.organizations.find((o: { tenantId: string }) => o.tenantId === a.tenant.id)).toMatchObject({ emails: 2, mailboxes: 1, openAlerts: 0 });
    expect(body.organizations.find((o: { tenantId: string }) => o.tenantId === b.tenant.id)).toMatchObject({ name: "Beta", emails: 1, openAlerts: 1 });
    expect(body.organizations.find((o: { tenantId: string }) => o.tenantId === off.id)).toMatchObject({ status: "disabled", emails: 0, lastEmailAt: null });

    const user = await createTestUser();
    await createTestMembership(user.id, a.tenant.id, ["stats:read"]);
    const member = buildServer({ logger: false, authResolver: async () => ({ id: user.id, email: user.email, isSuperAdmin: false }) });
    expect((await member.inject({ method: "GET", url: "/api/v1/admin/reports" })).statusCode).toBe(403);
    expect((await admin.inject({ method: "GET", url: "/api/v1/admin/reports?mailboxId=x" })).statusCode).toBe(400);
  });

  it("dismissing an alert needs organizations:write; it then leaves the open list", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const alert = await prisma.alert.create({ data: { tenantId: tenant.id, kind: "jev_errors", title: "Jev is down", detail: "d" } });
    const reader = await createTestUser();
    await createTestMembership(reader.id, tenant.id, ["stats:read"]);
    const limited = buildServer({ logger: false, authResolver: async () => ({ id: reader.id, email: reader.email, isSuperAdmin: false }) });
    expect((await limited.inject({ method: "POST", url: `/api/v1/alerts/${alert.id}/dismiss`, headers: { "x-organization-id": tenant.id } })).statusCode).toBe(403);

    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "POST", url: `/api/v1/alerts/${alert.id}/dismiss` });
    expect(res.json()).toMatchObject({ status: "dismissed", dismissedAt: expect.any(String) });
    expect((await app.inject({ method: "GET", url: "/api/v1/alerts" })).json().data).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/v1/alerts?status=dismissed" })).json().data).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: `/api/v1/alerts/${alert.id}/dismiss` })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/v1/alerts/nope/dismiss" })).statusCode).toBe(404);
  });

  it("the alert webhook URL is stored encrypted and never returned", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "PATCH", url: `/api/v1/organizations/${tenant.id}`, payload: { alertWebhookUrl: "https://hooks.acme.test/T0K3N", alertEmailsEnabled: false } });
    expect(res.json()).toMatchObject({ alertWebhookOrigin: "https://hooks.acme.test", alertEmailsEnabled: false });
    expect(JSON.stringify(res.json())).not.toContain("T0K3N");
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).alertWebhookUrlEncrypted).not.toContain("T0K3N");
    expect((await app.inject({ method: "PATCH", url: `/api/v1/organizations/${tenant.id}`, payload: { alertWebhookUrl: "ftp://x" } })).statusCode).toBe(400);
  });
});
