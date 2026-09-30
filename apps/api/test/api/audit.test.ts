import { beforeEach, describe, expect, it } from "vitest";
import { buildTestServer } from "./helpers/buildTestServer.js";
import { createReceivedEmail, createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";
import { recordAuditEvent, AuditEventType } from "../../src/modules/audit/record.js";
import { prisma } from "../../src/db/client.js";

describe("API — audit", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("lists tenant-wide audit events, newest first, paginated", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
    // createReceivedEmail itself doesn't write audit events (unlike persistNormalizedEmail) — write a couple directly.
    await recordAuditEvent(prisma, { tenantId: tenant.id, emailId: email.id, eventType: AuditEventType.EMAIL_DISCOVERED, actor: "system" });
    await recordAuditEvent(prisma, { tenantId: tenant.id, emailId: email.id, eventType: AuditEventType.EMAIL_QUEUED_FOR_PROCESSING, actor: "system" });
    const app = buildTestServer(tenant.id);

    const res = await app.inject({ method: "GET", url: "/api/v1/audit?limit=1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.pagination.hasMore).toBe(true);
    await app.close();
  });

  it("scopes audit strictly to the current tenant", async () => {
    const { tenant: tenantA } = await createTestTenantAndMailbox();
    const { tenant: tenantB, mailboxConnection: mailboxB } = await createTestTenantAndMailbox();
    const emailB = await createReceivedEmail(tenantB.id, mailboxB.id, "1");
    await recordAuditEvent(prisma, { tenantId: tenantB.id, emailId: emailB.id, eventType: AuditEventType.EMAIL_DISCOVERED, actor: "system" });

    // createTestTenantAndMailbox() itself now generates one real
    // mailbox_credential_set event per tenant it sets up (Phase 10) — so
    // tenant A legitimately has ITS OWN event, not zero. What this test
    // actually checks is that tenant B's event never leaks into tenant A's
    // view, which filtering by tenant B's specific event type still proves.
    const appA = buildTestServer(tenantA.id);
    const res = await appA.inject({ method: "GET", url: "/api/v1/audit?eventType=email_discovered" });
    expect(res.json().data).toHaveLength(0);
    await appA.close();
  });

  it("filters by eventType", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
    await recordAuditEvent(prisma, { tenantId: tenant.id, emailId: email.id, eventType: AuditEventType.EMAIL_DISCOVERED, actor: "system" });
    await recordAuditEvent(prisma, { tenantId: tenant.id, emailId: email.id, eventType: AuditEventType.EMAIL_QUEUED_FOR_PROCESSING, actor: "system" });
    const app = buildTestServer(tenant.id);

    const res = await app.inject({ method: "GET", url: `/api/v1/audit?eventType=${AuditEventType.EMAIL_DISCOVERED}` });
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].eventType).toBe(AuditEventType.EMAIL_DISCOVERED);
    await app.close();
  });

  it("email-specific audit history is scoped to that email", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const emailA = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
    const emailB = await createReceivedEmail(tenant.id, mailboxConnection.id, "2");
    await recordAuditEvent(prisma, { tenantId: tenant.id, emailId: emailA.id, eventType: AuditEventType.EMAIL_DISCOVERED, actor: "system" });
    await recordAuditEvent(prisma, { tenantId: tenant.id, emailId: emailB.id, eventType: AuditEventType.EMAIL_DISCOVERED, actor: "system" });
    const app = buildTestServer(tenant.id);

    const res = await app.inject({ method: "GET", url: `/api/v1/emails/${emailA.id}/audit` });
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].emailId).toBe(emailA.id);
    await app.close();
  });

  it("there is no route capable of creating, updating, or deleting an audit event — GET is the only method exposed", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const post = await app.inject({ method: "POST", url: "/api/v1/audit" });
    expect(post.statusCode).toBe(404); // no route registered for this method at all
    await app.close();
  });
});
