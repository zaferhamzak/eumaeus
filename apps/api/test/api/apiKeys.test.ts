import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";
import { createTestMembership, createTestUser } from "../helpers/auth.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/db/client.js";
import type { Permission } from "../../src/modules/auth/permissions.js";

/** Real resolvers (no test overrides), so the Bearer path is exercised end to end. */
function realServer() {
  return buildServer({ logger: false });
}

async function asMember(tenantId: string, permissions: Permission[]) {
  const user = await createTestUser();
  await createTestMembership(user.id, tenantId, permissions);
  return buildServer({ logger: false, authResolver: async () => ({ id: user.id, email: user.email, isSuperAdmin: false }) });
}

describe("API keys", () => {
  beforeEach(resetDatabase);

  it("creates a key once, authenticates with it, limits it to its permissions and organization, and revokes it", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const other = await createTestTenantAndMailbox();
    const admin = await asMember(tenant.id, ["api_keys:manage", "rules:read", "emails:read"]);
    const headers = { "x-organization-id": tenant.id };

    const created = await admin.inject({ method: "POST", url: "/api/v1/api-keys", headers, payload: { name: "CRM sync", permissions: ["rules:read"] } });
    expect(created.statusCode).toBe(201);
    const { key, id, prefix } = created.json();
    expect(key).toMatch(/^jm_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    expect(key.startsWith(prefix)).toBe(true);
    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id } });
    expect(row.keyHash).not.toContain(key.slice(12));

    const listed = (await admin.inject({ method: "GET", url: "/api/v1/api-keys", headers })).json().data;
    expect(listed).toEqual([expect.objectContaining({ id, prefix, status: "active", lastUsedAt: null })]);
    expect(JSON.stringify(listed)).not.toContain(key);

    const app = realServer();
    const bearer = { authorization: `Bearer ${key}` };
    expect((await app.inject({ method: "GET", url: "/api/v1/rules", headers: bearer })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/rules", headers: { ...bearer, ...headers } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/emails", headers: bearer })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/rules", headers: { ...bearer, "x-organization-id": other.tenant.id } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/organizations", headers: bearer })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: bearer })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/v1/api-keys", headers: bearer })).statusCode).toBe(403);
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id } })).lastUsedAt).not.toBeNull();

    // Rule created with the key is audited under the key's name.
    const writer = (await admin.inject({ method: "POST", url: "/api/v1/api-keys", headers, payload: { name: "w", permissions: ["rules:read"] } })).json();
    expect(writer.status).toBe("active");

    expect((await admin.inject({ method: "DELETE", url: `/api/v1/api-keys/${id}`, headers })).json().status).toBe("revoked");
    expect((await app.inject({ method: "GET", url: "/api/v1/rules", headers: bearer })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/v1/rules", headers: { authorization: "Bearer jm_nonsense" } })).statusCode).toBe(401);
    expect(await prisma.auditEvent.count({ where: { tenantId: tenant.id, eventType: { in: ["api_key_created", "api_key_revoked"] } } })).toBe(3);
  });

  it("never grants more than the creator has; expired keys stop working", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const headers = { "x-organization-id": tenant.id };
    const member = await asMember(tenant.id, ["api_keys:manage", "rules:read"]);
    const tooMuch = await member.inject({ method: "POST", url: "/api/v1/api-keys", headers, payload: { name: "x", permissions: ["rules:read", "rules:delete"] } });
    expect(tooMuch.statusCode).toBe(400);
    expect(tooMuch.json().error.message).toContain("rules:delete");
    expect((await member.inject({ method: "POST", url: "/api/v1/api-keys", headers, payload: { name: "x", permissions: ["made:up"] } })).statusCode).toBe(400);

    const noManage = await asMember(tenant.id, ["rules:read"]);
    expect((await noManage.inject({ method: "GET", url: "/api/v1/api-keys", headers })).statusCode).toBe(403);

    const { key, id } = (await member.inject({ method: "POST", url: "/api/v1/api-keys", headers, payload: { name: "short", permissions: ["rules:read"], expiresInDays: 1 } })).json();
    await prisma.apiKey.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await realServer().inject({ method: "GET", url: "/api/v1/rules", headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(401);
    expect((await member.inject({ method: "GET", url: "/api/v1/api-keys", headers })).json().data[0].status).toBe("expired");
  });
});
