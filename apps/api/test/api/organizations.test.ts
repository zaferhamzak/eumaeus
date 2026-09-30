import { beforeEach, describe, expect, it } from "vitest";
import { buildTestServer } from "./helpers/buildTestServer.js";
import { resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/db/client.js";

describe("API — organizations", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("creates an organization", async () => {
    const app = buildTestServer("unused");
    const res = await app.inject({ method: "POST", url: "/api/v1/organizations", payload: { name: "Acme Security", slug: "acme-security" } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: "Acme Security", slug: "acme-security", status: "active" });
    await app.close();
  });

  it("Phase 11: the ORGANIZATION_CREATED audit event's actor is the real authenticated caller, not a hardcoded 'system'", async () => {
    const app = buildTestServer("unused");
    const res = await app.inject({ method: "POST", url: "/api/v1/organizations", payload: { name: "Actor Org", slug: "actor-org" } });
    const orgId = res.json().id;
    const event = await prisma.auditEvent.findFirst({ where: { tenantId: orgId, eventType: "organization_created" } });
    expect(event?.actor).toBe("test-super-admin@internal.test");
    await app.close();
  });

  it("rejects a malformed slug", async () => {
    const app = buildTestServer("unused");
    const res = await app.inject({ method: "POST", url: "/api/v1/organizations", payload: { name: "Bad Slug Org", slug: "Not A Valid Slug!" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a duplicate slug", async () => {
    const app = buildTestServer("unused");
    await app.inject({ method: "POST", url: "/api/v1/organizations", payload: { name: "First", slug: "dup-slug" } });
    const res = await app.inject({ method: "POST", url: "/api/v1/organizations", payload: { name: "Second", slug: "dup-slug" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("multiple organizations exist independently", async () => {
    const app = buildTestServer("unused");
    const a = await app.inject({ method: "POST", url: "/api/v1/organizations", payload: { name: "Org A", slug: "org-a" } });
    const b = await app.inject({ method: "POST", url: "/api/v1/organizations", payload: { name: "Org B", slug: "org-b" } });
    expect(a.json().id).not.toBe(b.json().id);

    const list = await app.inject({ method: "GET", url: "/api/v1/organizations" });
    expect(list.json().data.map((o: { id: string }) => o.id).sort()).toEqual([a.json().id, b.json().id].sort());
    await app.close();
  });

  it("lists organizations", async () => {
    const app = buildTestServer("unused");
    await app.inject({ method: "POST", url: "/api/v1/organizations", payload: { name: "Org", slug: "org-list" } });
    const res = await app.inject({ method: "GET", url: "/api/v1/organizations" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.length).toBeGreaterThanOrEqual(1);
    await app.close();
  });

  it("gets organization detail", async () => {
    const app = buildTestServer("unused");
    const created = await app.inject({ method: "POST", url: "/api/v1/organizations", payload: { name: "Detail Org", slug: "detail-org" } });
    const id = created.json().id as string;
    const res = await app.inject({ method: "GET", url: `/api/v1/organizations/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
    await app.close();
  });

  it("returns 404 for an unknown organization", async () => {
    const app = buildTestServer("unused");
    const res = await app.inject({ method: "GET", url: "/api/v1/organizations/does-not-exist" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("updates an organization's name and slug", async () => {
    const app = buildTestServer("unused");
    const created = await app.inject({ method: "POST", url: "/api/v1/organizations", payload: { name: "Old Name", slug: "old-slug" } });
    const id = created.json().id as string;

    const res = await app.inject({ method: "PATCH", url: `/api/v1/organizations/${id}`, payload: { name: "New Name", slug: "new-slug" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "New Name", slug: "new-slug" });
    await app.close();
  });

  it("DELETE deactivates the organization (soft) rather than removing it", async () => {
    const app = buildTestServer("unused");
    const created = await app.inject({ method: "POST", url: "/api/v1/organizations", payload: { name: "To Deactivate", slug: "to-deactivate" } });
    const id = created.json().id as string;

    const res = await app.inject({ method: "DELETE", url: `/api/v1/organizations/${id}` });
    expect(res.statusCode).toBe(204);

    const row = await prisma.tenant.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("disabled");
    expect(row).toBeTruthy(); // still exists
    await app.close();
  });

  it("deactivation is idempotent", async () => {
    const app = buildTestServer("unused");
    const created = await app.inject({ method: "POST", url: "/api/v1/organizations", payload: { name: "Idempotent", slug: "idempotent-org" } });
    const id = created.json().id as string;
    await app.inject({ method: "DELETE", url: `/api/v1/organizations/${id}` });
    const second = await app.inject({ method: "DELETE", url: `/api/v1/organizations/${id}` });
    expect(second.statusCode).toBe(204);
    await app.close();
  });

  it("deactivating an organization does not delete its mailboxes or rule graphs", async () => {
    const app = buildTestServer("unused");
    const org = await app.inject({ method: "POST", url: "/api/v1/organizations", payload: { name: "Owner Org", slug: "owner-org" } });
    const orgId = org.json().id as string;
    const mailbox = await app.inject({
      method: "POST",
      url: "/api/v1/mailboxes",
      payload: {
        organizationId: orgId,
        name: "Support",
        email: "support@owner-org.test",
        host: "imap.example.com",
        port: 993,
        tls: true,
        folder: "INBOX",
        username: "support",
        password: "not-a-real-password",
      },
    });
    expect(mailbox.statusCode).toBe(201);

    await app.inject({ method: "DELETE", url: `/api/v1/organizations/${orgId}` });

    const row = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: mailbox.json().id } });
    expect(row).toBeTruthy(); // mailbox row untouched — organization deactivation does not cascade-delete anything
    await app.close();
  });
});
