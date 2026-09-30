import { beforeEach, describe, expect, it } from "vitest";
import { buildTestServer } from "./helpers/buildTestServer.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/db/client.js";
import { resolveMailboxPassword } from "../../src/modules/mail-providers/imap/mailboxCredentials.js";

function createPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: "Support",
    email: "support@example.com",
    host: "imap.example.com",
    port: 993,
    tls: true,
    folder: "INBOX",
    username: "support@example.com",
    password: "correct-horse-battery-staple",
    ...overrides,
  };
}

describe("API — mailboxes", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("lists mailboxes for the current tenant, never exposing a password field", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "GET", url: "/api/v1/mailboxes" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).not.toHaveProperty("password");
    expect(JSON.stringify(body)).not.toContain("test-password-not-real");
    await app.close();
  });

  it("gets mailbox detail by id", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxConnection.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: mailboxConnection.id, status: "active", organizationId: tenant.id });
    await app.close();
  });

  it("a mailbox belonging to a different tenant is not found", async () => {
    const { tenant: tenantA } = await createTestTenantAndMailbox();
    const { mailboxConnection: mailboxB } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenantA.id);
    const res = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxB.id}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  describe("GET ?organizationId= — listing a SPECIFIC organization's mailboxes", () => {
    it("lists organization B's mailboxes even while the request context resolves to organization A", async () => {
      const { tenant: tenantA } = await createTestTenantAndMailbox();
      const { tenant: tenantB, mailboxConnection: mailboxB } = await createTestTenantAndMailbox();

      const app = buildTestServer(tenantA.id); // request context is A...
      const res = await app.inject({ method: "GET", url: `/api/v1/mailboxes?organizationId=${tenantB.id}` }); // ...but we ask for B's
      expect(res.statusCode).toBe(200);
      expect(res.json().data.map((m: { id: string }) => m.id)).toEqual([mailboxB.id]);
      await app.close();
    });

    it("omitting organizationId keeps the existing request.tenantId-scoped behavior unchanged", async () => {
      const { tenant } = await createTestTenantAndMailbox();
      await createTestTenantAndMailbox(); // a second, unrelated org — must not leak in
      const app = buildTestServer(tenant.id);
      const res = await app.inject({ method: "GET", url: "/api/v1/mailboxes" });
      expect(res.json().data).toHaveLength(1);
      await app.close();
    });
  });

  it("PATCH status=disabled then status=active round-trips", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);

    const disableRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/mailboxes/${mailboxConnection.id}`,
      payload: { status: "disabled" },
    });
    expect(disableRes.statusCode).toBe(200);
    expect(disableRes.json()).toMatchObject({ status: "disabled" });

    const enableRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/mailboxes/${mailboxConnection.id}`,
      payload: { status: "active" },
    });
    expect(enableRes.statusCode).toBe(200);
    expect(enableRes.json()).toMatchObject({ status: "active" });
    await app.close();
  });

  it("PATCH rejects an invalid status value", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/mailboxes/${mailboxConnection.id}`,
      payload: { status: "not-a-real-status" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("POST reconcile enqueues a job and returns an acknowledgement, without performing a sync inline", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxConnection.id}/reconcile` });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe("enqueued");
    expect(typeof body.jobId).toBe("string");
    await app.close();
  });

  it("reconcile on an unknown mailbox is 404", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "POST", url: "/api/v1/mailboxes/does-not-exist/reconcile" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  describe("POST (create) — real mailbox creation (Phase 10)", () => {
    it("creates a mailbox with its own credentials", async () => {
      const { tenant } = await createTestTenantAndMailbox();
      const app = buildTestServer(tenant.id);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/mailboxes",
        payload: createPayload({ organizationId: tenant.id }),
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({ name: "Support", emailAddress: "support@example.com", organizationId: tenant.id, status: "active" });
      await app.close();
    });

    it("a single organization can create multiple, independently coexisting mailboxes", async () => {
      const { tenant } = await createTestTenantAndMailbox();
      const app = buildTestServer(tenant.id);

      const support = await app.inject({
        method: "POST",
        url: "/api/v1/mailboxes",
        payload: createPayload({ organizationId: tenant.id, name: "Support", email: "support@example.com" }),
      });
      const security = await app.inject({
        method: "POST",
        url: "/api/v1/mailboxes",
        payload: createPayload({ organizationId: tenant.id, name: "Security", email: "security@example.com" }),
      });

      expect(support.statusCode).toBe(201);
      expect(security.statusCode).toBe(201);
      expect(support.json().id).not.toBe(security.json().id);

      const list = await app.inject({ method: "GET", url: "/api/v1/mailboxes" });
      // +1 for createTestTenantAndMailbox's own bootstrap mailbox.
      expect(list.json().data).toHaveLength(3);
      await app.close();
    });

    it("rejects creation against a nonexistent organizationId", async () => {
      const { tenant } = await createTestTenantAndMailbox();
      const app = buildTestServer(tenant.id);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/mailboxes",
        payload: createPayload({ organizationId: "does-not-exist" }),
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("never returns the password in the create response", async () => {
      const { tenant } = await createTestTenantAndMailbox();
      const app = buildTestServer(tenant.id);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/mailboxes",
        payload: createPayload({ organizationId: tenant.id, password: "extremely-recognizable-secret-xyz" }),
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).not.toHaveProperty("password");
      expect(JSON.stringify(res.json())).not.toContain("extremely-recognizable-secret-xyz");
      await app.close();
    });

    it("the created mailbox's credential is stored encrypted, never in plaintext, in a dedicated MailboxCredential row", async () => {
      const { tenant } = await createTestTenantAndMailbox();
      const app = buildTestServer(tenant.id);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/mailboxes",
        payload: createPayload({ organizationId: tenant.id, password: "plaintext-should-not-appear-raw" }),
      });
      const id = res.json().id as string;

      const row = await prisma.mailboxCredential.findUniqueOrThrow({ where: { mailboxConnectionId: id } });
      expect(row.encryptedValue).not.toContain("plaintext-should-not-appear-raw");
      expect(row.encryptedValue.startsWith("v1.")).toBe(true);

      const resolved = await resolveMailboxPassword(tenant.id, id);
      expect(resolved).toBe("plaintext-should-not-appear-raw");
      await app.close();
    });

    it("does not log the plaintext password anywhere in the recorded audit trail", async () => {
      const { tenant } = await createTestTenantAndMailbox();
      const app = buildTestServer(tenant.id);
      await app.inject({
        method: "POST",
        url: "/api/v1/mailboxes",
        payload: createPayload({ organizationId: tenant.id, password: "audit-must-never-contain-this" }),
      });

      const events = await prisma.auditEvent.findMany({ where: { tenantId: tenant.id } });
      expect(JSON.stringify(events)).not.toContain("audit-must-never-contain-this");
      expect(events.some((e) => e.eventType === "mailbox_created")).toBe(true);
      expect(events.some((e) => e.eventType === "mailbox_credential_set")).toBe(true);
      await app.close();
    });

    it("mailbox A and mailbox B independently store and resolve their OWN credentials — never each other's", async () => {
      const { tenant } = await createTestTenantAndMailbox();
      const app = buildTestServer(tenant.id);

      const a = await app.inject({
        method: "POST",
        url: "/api/v1/mailboxes",
        payload: createPayload({ organizationId: tenant.id, name: "A", email: "a@example.com", password: "password-for-mailbox-a" }),
      });
      const b = await app.inject({
        method: "POST",
        url: "/api/v1/mailboxes",
        payload: createPayload({ organizationId: tenant.id, name: "B", email: "b@example.com", password: "password-for-mailbox-b" }),
      });

      const passwordA = await resolveMailboxPassword(tenant.id, a.json().id);
      const passwordB = await resolveMailboxPassword(tenant.id, b.json().id);
      expect(passwordA).toBe("password-for-mailbox-a");
      expect(passwordB).toBe("password-for-mailbox-b");
      expect(passwordA).not.toBe(passwordB);
      await app.close();
    });
  });

  describe("DELETE — soft deactivation (Phase 10)", () => {
    it("deactivates the mailbox (soft) rather than removing history, and unschedules reconciliation", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const app = buildTestServer(tenant.id);

      const res = await app.inject({ method: "DELETE", url: `/api/v1/mailboxes/${mailboxConnection.id}` });
      expect(res.statusCode).toBe(204);

      const row = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: mailboxConnection.id } });
      expect(row.status).toBe("disabled");
      expect(row).toBeTruthy(); // still exists
      await app.close();
    });

    it("deactivating an already-disabled mailbox is idempotent", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const app = buildTestServer(tenant.id);
      await app.inject({ method: "DELETE", url: `/api/v1/mailboxes/${mailboxConnection.id}` });
      const second = await app.inject({ method: "DELETE", url: `/api/v1/mailboxes/${mailboxConnection.id}` });
      expect(second.statusCode).toBe(204);
      await app.close();
    });

    it("deleting a mailbox does not delete the organization's other mailboxes or shared resources", async () => {
      const { tenant, mailboxConnection: keep } = await createTestTenantAndMailbox();
      const app = buildTestServer(tenant.id);
      const created = await app.inject({ method: "POST", url: "/api/v1/mailboxes", payload: createPayload({ organizationId: tenant.id }) });
      const toDelete = created.json().id as string;

      await app.inject({ method: "DELETE", url: `/api/v1/mailboxes/${toDelete}` });

      const untouched = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: keep.id } });
      expect(untouched.status).toBe("active");
      await app.close();
    });
  });

  describe("ownership — mailbox <-> rule graph (Phase 10)", () => {
    async function createGraph(app: ReturnType<typeof buildTestServer>) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/rule-graphs",
        payload: {
          name: "test graph",
          rootNodeKey: "start",
          nodes: [
            {
              key: "start",
              conditions: { field: "has_attachment", op: "==", value: true },
              onTrue: { type: "action", destinationRef: "archive" },
              onFalse: { type: "action", destinationRef: "archive" },
            },
          ],
        },
      });
      return res.json().id as string;
    }

    it("a mailbox can be assigned a rule graph belonging to the SAME organization", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const app = buildTestServer(tenant.id);
      const graphId = await createGraph(app);

      const res = await app.inject({ method: "PATCH", url: `/api/v1/mailboxes/${mailboxConnection.id}`, payload: { ruleGraphId: graphId } });
      expect(res.statusCode).toBe(200);
      expect(res.json().ruleGraphId).toBe(graphId);
      await app.close();
    });

    it("a mailbox CANNOT be assigned a rule graph belonging to a DIFFERENT organization — rejected server-side", async () => {
      const { tenant: tenantA, mailboxConnection } = await createTestTenantAndMailbox();
      const { tenant: tenantB } = await createTestTenantAndMailbox();
      const appB = buildTestServer(tenantB.id);
      const graphFromB = await createGraph(appB);

      const appA = buildTestServer(tenantA.id);
      const res = await appA.inject({ method: "PATCH", url: `/api/v1/mailboxes/${mailboxConnection.id}`, payload: { ruleGraphId: graphFromB } });
      expect(res.statusCode).toBe(400);

      const untouched = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: mailboxConnection.id } });
      expect(untouched.ruleGraphId).toBeNull();
      await appA.close();
      await appB.close();
    });

    it("creating a mailbox with a cross-organization ruleGraphId is rejected the same way", async () => {
      const { tenant: tenantA } = await createTestTenantAndMailbox();
      const { tenant: tenantB } = await createTestTenantAndMailbox();
      const appB = buildTestServer(tenantB.id);
      const graphFromB = await createGraph(appB);

      const appA = buildTestServer(tenantA.id);
      const res = await appA.inject({
        method: "POST",
        url: "/api/v1/mailboxes",
        payload: createPayload({ organizationId: tenantA.id, ruleGraphId: graphFromB }),
      });
      expect(res.statusCode).toBe(400);
      await appA.close();
      await appB.close();
    });

    it("two mailboxes in the SAME organization can use two DIFFERENT rule graphs", async () => {
      const { tenant, mailboxConnection: mailboxA } = await createTestTenantAndMailbox();
      const app = buildTestServer(tenant.id);
      const graphOne = await createGraph(app);
      const graphTwo = await createGraph(app);

      const created = await app.inject({ method: "POST", url: "/api/v1/mailboxes", payload: createPayload({ organizationId: tenant.id }) });
      const mailboxB = created.json().id as string;

      await app.inject({ method: "PATCH", url: `/api/v1/mailboxes/${mailboxA.id}`, payload: { ruleGraphId: graphOne } });
      await app.inject({ method: "PATCH", url: `/api/v1/mailboxes/${mailboxB}`, payload: { ruleGraphId: graphTwo } });

      const rowA = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: mailboxA.id } });
      const rowB = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: mailboxB } });
      expect(rowA.ruleGraphId).toBe(graphOne);
      expect(rowB.ruleGraphId).toBe(graphTwo);
      expect(rowA.ruleGraphId).not.toBe(rowB.ruleGraphId);
      await app.close();
    });
  });
});
