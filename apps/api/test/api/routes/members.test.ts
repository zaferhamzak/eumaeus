import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../../src/api/server.js";
import { resetDatabase } from "../../helpers/db.js";
import { createTestMembership, createTestSuperAdmin, createTestUser } from "../../helpers/auth.js";
import { prisma } from "../../../src/db/client.js";
import type { AuthenticatedUser } from "../../../src/api/plugins/authContext.js";

describe("organization member routes", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  function appAs(user: AuthenticatedUser) {
    return buildServer({ logger: false, authResolver: async () => user });
  }

  it("members:invite creates a pending Membership and returns a raw token once", async () => {
    const admin = await createTestUser();
    const org = await prisma.tenant.create({ data: { name: "Org" } });
    await createTestMembership(admin.id, org.id, ["members:invite"]);

    const app = appAs({ id: admin.id, email: admin.email, isSuperAdmin: false });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${org.id}/members`,
      payload: { email: "newbie@example.com", permissions: ["rules:read"] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.membership.status).toBe("pending");
    expect(body.membership.permissions).toEqual(["rules:read"]);
    expect(typeof body.inviteToken).toBe("string");
    expect(body.inviteToken.length).toBeGreaterThan(20);
    await app.close();
  });

  it("returns a ready-to-share acceptUrl containing the raw token, and emailSent:false when SMTP isn't configured (the test-suite default)", async () => {
    const admin = await createTestUser();
    const org = await prisma.tenant.create({ data: { name: "Org" } });
    await createTestMembership(admin.id, org.id, ["members:invite"]);

    const app = appAs({ id: admin.id, email: admin.email, isSuperAdmin: false });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${org.id}/members`,
      payload: { email: "linkonly@example.com", permissions: [] },
    });
    const body = res.json();
    expect(body.emailSent).toBe(false);
    expect(body.acceptUrl).toContain("/accept-invite?token=");
    expect(body.acceptUrl).toContain(encodeURIComponent(body.inviteToken));
    await app.close();
  });

  it("members:read lists members, without exposing the invite token hash", async () => {
    const admin = await createTestUser();
    const org = await prisma.tenant.create({ data: { name: "Org" } });
    await createTestMembership(admin.id, org.id, ["members:read", "members:invite"]);

    const app = appAs({ id: admin.id, email: admin.email, isSuperAdmin: false });
    await app.inject({ method: "POST", url: `/api/v1/organizations/${org.id}/members`, payload: { email: "a@example.com", permissions: [] } });

    const res = await app.inject({ method: "GET", url: `/api/v1/organizations/${org.id}/members` });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data;
    expect(rows).toHaveLength(2); // admin's own membership + the invited one
    for (const row of rows) {
      expect(row).not.toHaveProperty("inviteTokenHash");
    }
    await app.close();
  });

  it("a member without members:invite is forbidden from inviting", async () => {
    const user = await createTestUser();
    const org = await prisma.tenant.create({ data: { name: "Org" } });
    await createTestMembership(user.id, org.id, ["members:read"]); // read, not invite

    const app = appAs({ id: user.id, email: user.email, isSuperAdmin: false });
    const res = await app.inject({ method: "POST", url: `/api/v1/organizations/${org.id}/members`, payload: { email: "x@example.com", permissions: [] } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("rejects an invite permission string outside the closed catalog", async () => {
    const admin = await createTestSuperAdmin();
    const org = await prisma.tenant.create({ data: { name: "Org" } });
    const app = appAs({ id: admin.id, email: admin.email, isSuperAdmin: true });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${org.id}/members`,
      payload: { email: "x@example.com", permissions: ["not:a:real:permission"] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("members:manage can update an existing member's permissions", async () => {
    const admin = await createTestUser();
    const target = await createTestUser();
    const org = await prisma.tenant.create({ data: { name: "Org" } });
    await createTestMembership(admin.id, org.id, ["members:manage"]);
    const targetMembership = await createTestMembership(target.id, org.id, ["rules:read"]);

    const app = appAs({ id: admin.id, email: admin.email, isSuperAdmin: false });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${org.id}/members/${targetMembership.id}`,
      payload: { permissions: ["rules:read", "rules:write"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().permissions).toEqual(["rules:read", "rules:write"]);
    await app.close();
  });

  it("members:manage can revoke an existing member — a subsequent request under that membership is then forbidden", async () => {
    const admin = await createTestUser();
    const target = await createTestUser();
    const org = await prisma.tenant.create({ data: { name: "Org" } });
    await createTestMembership(admin.id, org.id, ["members:manage"]);
    const targetMembership = await createTestMembership(target.id, org.id, ["stats:read"]);

    const app = appAs({ id: admin.id, email: admin.email, isSuperAdmin: false });
    const del = await app.inject({ method: "DELETE", url: `/api/v1/organizations/${org.id}/members/${targetMembership.id}` });
    expect(del.statusCode).toBe(204);

    const targetApp = appAs({ id: target.id, email: target.email, isSuperAdmin: false });
    const res = await targetApp.inject({ method: "GET", url: "/api/v1/stats", headers: { "x-organization-id": org.id } });
    expect(res.statusCode).toBe(403);
    await app.close();
    await targetApp.close();
  });

  it("cannot manage a membership belonging to a DIFFERENT organization via the URL", async () => {
    const admin = await createTestUser();
    const orgA = await prisma.tenant.create({ data: { name: "Org A" } });
    const orgB = await prisma.tenant.create({ data: { name: "Org B" } });
    await createTestMembership(admin.id, orgA.id, ["members:manage"]);
    const otherUser = await createTestUser();
    const membershipInB = await createTestMembership(otherUser.id, orgB.id, ["stats:read"]);

    const app = appAs({ id: admin.id, email: admin.email, isSuperAdmin: false });
    // Admin has members:manage in org A, but tries to touch a membership that belongs to org B.
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${orgA.id}/members/${membershipInB.id}`,
      payload: { status: "revoked" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
