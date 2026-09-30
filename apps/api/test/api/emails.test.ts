import { beforeEach, describe, expect, it } from "vitest";
import { buildTestServer } from "./helpers/buildTestServer.js";
import {
  createArchiveDestination,
  createMatchedRoutingDecision,
  createReceivedEmail,
  createSuccessfulAnalysis,
  createTestTenantAndMailbox,
  defaultAnswers,
  resetDatabase,
} from "../helpers/db.js";
import { prisma } from "../../src/db/client.js";

describe("API — emails", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("lists emails for the current tenant, newest first, with pagination", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    await createReceivedEmail(tenant.id, mailboxConnection.id, "1", { subject: "First" });
    await createReceivedEmail(tenant.id, mailboxConnection.id, "2", { subject: "Second" });
    const app = buildTestServer(tenant.id);

    const res = await app.inject({ method: "GET", url: "/api/v1/emails?limit=1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.pagination.hasMore).toBe(true);
    expect(typeof body.pagination.nextCursor).toBe("string");

    const page2 = await app.inject({ method: "GET", url: `/api/v1/emails?limit=1&cursor=${body.pagination.nextCursor}` });
    expect(page2.json().data).toHaveLength(1);
    expect(page2.json().data[0].id).not.toBe(body.data[0].id);
    await app.close();
  });

  it("filters by state", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const a = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
    await createReceivedEmail(tenant.id, mailboxConnection.id, "2");
    await prisma.email.update({ where: { id: a.id }, data: { state: "failed" } });
    const app = buildTestServer(tenant.id);

    const res = await app.inject({ method: "GET", url: "/api/v1/emails?state=failed" });
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe(a.id);
    await app.close();
  });

  it("filters by sender (case-insensitive contains)", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    await createReceivedEmail(tenant.id, mailboxConnection.id, "1", { fromAddress: "Alice@Example.com" });
    await createReceivedEmail(tenant.id, mailboxConnection.id, "2", { fromAddress: "bob@other.com" });
    const app = buildTestServer(tenant.id);

    const res = await app.inject({ method: "GET", url: "/api/v1/emails?sender=alice" });
    expect(res.json().data).toHaveLength(1);
    await app.close();
  });

  it("detail excludes the raw body by default, and includes it only with includeBody=true", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1", { textBody: "the raw untrusted body" });
    const app = buildTestServer(tenant.id);

    const withoutBody = await app.inject({ method: "GET", url: `/api/v1/emails/${email.id}` });
    expect(withoutBody.json().body).toBeNull();
    expect(JSON.stringify(withoutBody.json())).not.toContain("the raw untrusted body");

    const withBody = await app.inject({ method: "GET", url: `/api/v1/emails/${email.id}?includeBody=true` });
    expect(withBody.json().body.text).toBe("the raw untrusted body");
    await app.close();
  });

  it("detail includes analysis, routing, and action-execution summaries when present", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
    const analysis = await createSuccessfulAnalysis(tenant.id, email.id, defaultAnswers());
    const { destination } = await createArchiveDestination(tenant.id, "sales");
    await createMatchedRoutingDecision(tenant.id, email.id, destination.name, analysis.id);
    const app = buildTestServer(tenant.id);

    const res = await app.inject({ method: "GET", url: `/api/v1/emails/${email.id}` });
    const body = res.json();
    expect(body.analysis.id).toBe(analysis.id);
    expect(body.routingDecision.destinationRef).toBe("sales");
    expect(body.actionExecutions).toEqual([]);
    await app.close();
  });

  it("nested GET /emails/:id/analysis returns 404 when no analysis exists yet", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "GET", url: `/api/v1/emails/${email.id}/analysis` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("nested GET /emails/:id/routing, /executions, /audit all work and scope correctly", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
    const app = buildTestServer(tenant.id);

    const audit = await app.inject({ method: "GET", url: `/api/v1/emails/${email.id}/audit` });
    expect(audit.statusCode).toBe(200);
    expect(Array.isArray(audit.json().data)).toBe(true);

    const executions = await app.inject({ method: "GET", url: `/api/v1/emails/${email.id}/executions` });
    expect(executions.statusCode).toBe(200);
    expect(executions.json().data).toEqual([]);

    const routing = await app.inject({ method: "GET", url: `/api/v1/emails/${email.id}/routing` });
    expect(routing.statusCode).toBe(404); // none created yet
    await app.close();
  });

  it("an email belonging to a different tenant is not found, including nested resources", async () => {
    const { tenant: tenantA } = await createTestTenantAndMailbox();
    const { tenant: tenantB, mailboxConnection: mailboxB } = await createTestTenantAndMailbox();
    const emailB = await createReceivedEmail(tenantB.id, mailboxB.id, "1");
    const appA = buildTestServer(tenantA.id);

    const detail = await appA.inject({ method: "GET", url: `/api/v1/emails/${emailB.id}` });
    expect(detail.statusCode).toBe(404);
    const audit = await appA.inject({ method: "GET", url: `/api/v1/emails/${emailB.id}/audit` });
    expect(audit.statusCode).toBe(404);
    await appA.close();
  });
});
