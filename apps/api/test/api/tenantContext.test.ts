import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";
import { resetDatabase } from "../helpers/db.js";
import { createTestMembership, createTestSuperAdmin, createTestUser } from "../helpers/auth.js";
import { prisma } from "../../src/db/client.js";
import type { AuthenticatedUser } from "../../src/api/plugins/authContext.js";

/**
 * Uses the REAL defaultTenantResolver (via buildServer directly, not
 * buildTestServer — which always injects a fixed test-only resolver and so
 * never exercises this code path at all), paired with a real authResolver
 * to exercise the Phase 11 rewrite: login required, header required (no
 * more silent "first-created tenant" fallback), and access gated by a real
 * Membership (or superAdmin).
 */
describe("defaultTenantResolver — Phase 11 (auth + membership required)", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  function appAs(user: AuthenticatedUser | null) {
    return buildServer({ logger: false, authResolver: async () => user });
  }

  it("401s on any tenant-scoped route with no authenticated user at all", async () => {
    await prisma.tenant.create({ data: { name: "Org" } });
    const app = appAs(null);
    const res = await app.inject({ method: "GET", url: "/api/v1/stats" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("a logged-in user with no X-Organization-Id header is rejected (no more silent fallback to the first-created tenant)", async () => {
    const superAdmin = await createTestSuperAdmin();
    await prisma.tenant.create({ data: { name: "Org" } });
    const app = appAs({ id: superAdmin.id, email: superAdmin.email, isSuperAdmin: true });
    const res = await app.inject({ method: "GET", url: "/api/v1/stats" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("superAdmin can act on ANY organization via the header, with no Membership row required", async () => {
    const superAdmin = await createTestSuperAdmin();
    const orgA = await prisma.tenant.create({ data: { name: "Org A" } });
    const orgB = await prisma.tenant.create({ data: { name: "Org B" } });
    const app = appAs({ id: superAdmin.id, email: superAdmin.email, isSuperAdmin: true });

    const ruleResA = await app.inject({
      method: "POST",
      url: "/api/v1/rules",
      headers: { "x-organization-id": orgA.id },
      payload: { name: "r", priority: 1, conditions: { field: "subject", op: "==", value: "x" }, destinationRef: "sales" },
    });
    expect(ruleResA.statusCode).toBe(201);
    expect(ruleResA.json().tenantId).toBe(orgA.id);

    const ruleResB = await app.inject({
      method: "POST",
      url: "/api/v1/rules",
      headers: { "x-organization-id": orgB.id },
      payload: { name: "r2", priority: 1, conditions: { field: "subject", op: "==", value: "y" }, destinationRef: "sales" },
    });
    expect(ruleResB.statusCode).toBe(201);
    expect(ruleResB.json().tenantId).toBe(orgB.id);
    await app.close();
  });

  it("rejects a header that does not reference a real organization", async () => {
    const superAdmin = await createTestSuperAdmin();
    const app = appAs({ id: superAdmin.id, email: superAdmin.email, isSuperAdmin: true });
    const res = await app.inject({ method: "GET", url: "/api/v1/mailboxes", headers: { "x-organization-id": "does-not-exist" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("a regular (non-superAdmin) user WITH an active Membership can act on that organization", async () => {
    const user = await createTestUser();
    const org = await prisma.tenant.create({ data: { name: "Org" } });
    await createTestMembership(user.id, org.id, ["stats:read"]);
    const app = appAs({ id: user.id, email: user.email, isSuperAdmin: false });

    const res = await app.inject({ method: "GET", url: "/api/v1/stats", headers: { "x-organization-id": org.id } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("a regular user with NO Membership in the target organization is forbidden (403), not silently scoped to it", async () => {
    const user = await createTestUser();
    const org = await prisma.tenant.create({ data: { name: "Org" } });
    const app = appAs({ id: user.id, email: user.email, isSuperAdmin: false });

    const res = await app.inject({ method: "GET", url: "/api/v1/stats", headers: { "x-organization-id": org.id } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("a PENDING (not yet accepted) or REVOKED Membership does not grant access", async () => {
    const user = await createTestUser();
    const org = await prisma.tenant.create({ data: { name: "Org" } });
    await createTestMembership(user.id, org.id, ["stats:read"], "pending");
    const app = appAs({ id: user.id, email: user.email, isSuperAdmin: false });

    const res = await app.inject({ method: "GET", url: "/api/v1/stats", headers: { "x-organization-id": org.id } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("every existing resource is transparently scoped by the header — e.g. mailboxes list, with zero changes to that route", async () => {
    const superAdmin = await createTestSuperAdmin();
    const orgA = await prisma.tenant.create({ data: { name: "Org A" } });
    const orgB = await prisma.tenant.create({ data: { name: "Org B" } });
    await prisma.mailboxConnection.create({
      data: { tenantId: orgB.id, provider: "imap", emailAddress: "b@example.com", providerConfig: { host: "h", port: 993, tls: true, folder: "INBOX", username: "b" }, status: "active" },
    });

    const app = appAs({ id: superAdmin.id, email: superAdmin.email, isSuperAdmin: true });
    const resA = await app.inject({ method: "GET", url: "/api/v1/mailboxes", headers: { "x-organization-id": orgA.id } });
    expect(resA.json().data).toHaveLength(0);

    const resB = await app.inject({ method: "GET", url: "/api/v1/mailboxes", headers: { "x-organization-id": orgB.id } });
    expect(resB.json().data).toHaveLength(1);
    await app.close();
  });

  it("GET /api/v1/organizations (list) needs no X-Organization-Id header — just a logged-in user", async () => {
    const user = await createTestUser();
    const app = appAs({ id: user.id, email: user.email, isSuperAdmin: false });
    const res = await app.inject({ method: "GET", url: "/api/v1/organizations" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
