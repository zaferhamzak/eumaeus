import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../../src/api/server.js";
import { resetDatabase } from "../../helpers/db.js";
import { createTestSuperAdmin, createTestUser, createTestMembership } from "../../helpers/auth.js";
import { prisma } from "../../../src/db/client.js";
import type { AuthenticatedUser } from "../../../src/api/plugins/authContext.js";

describe("GET/PATCH /api/v1/settings — superAdmin-only, global (no X-Organization-Id needed)", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  function appAs(user: AuthenticatedUser | null) {
    return buildServer({ logger: false, authResolver: async () => user });
  }

  it("401s with no session", async () => {
    const res = await appAs(null).inject({ method: "GET", url: "/api/v1/settings" });
    expect(res.statusCode).toBe(401);
  });

  it("403s a logged-in non-superAdmin, even one with every permission in some organization", async () => {
    const user = await createTestUser();
    const org = await prisma.tenant.create({ data: { name: "Org" } });
    await createTestMembership(user.id, org.id, ["organizations:write", "mailboxes:write"]);
    const res = await appAs({ id: user.id, email: user.email, isSuperAdmin: false }).inject({ method: "GET", url: "/api/v1/settings" });
    expect(res.statusCode).toBe(403);
  });

  it("superAdmin can read settings with NO X-Organization-Id header at all", async () => {
    const admin = await createTestSuperAdmin();
    const res = await appAs({ id: admin.id, email: admin.email, isSuperAdmin: true }).inject({ method: "GET", url: "/api/v1/settings" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.appBaseUrl).toBeDefined();
    expect(body.smtpPasswordSet).toBe(false);
    expect(body).not.toHaveProperty("smtpPassword");
    expect(body).not.toHaveProperty("smtpPasswordEncrypted");
  });

  it("superAdmin can update settings — the response reflects the change, and smtpPasswordSet flips true after setting a password", async () => {
    const admin = await createTestSuperAdmin();
    const app = appAs({ id: admin.id, email: admin.email, isSuperAdmin: true });
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      payload: { appBaseUrl: "https://eumaeus.example.com", smtpHost: "smtp.gmail.com", smtpPassword: "app-password-123" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.appBaseUrl).toBe("https://eumaeus.example.com");
    expect(body.smtpHost).toBe("smtp.gmail.com");
    expect(body.smtpPasswordSet).toBe(true);
    expect(body.updatedBy).toBe(admin.email);
  });

  it("rejects an unknown field (strict schema)", async () => {
    const admin = await createTestSuperAdmin();
    const res = await appAs({ id: admin.id, email: admin.email, isSuperAdmin: true }).inject({
      method: "PATCH",
      url: "/api/v1/settings",
      payload: { notARealField: "x" },
    });
    expect(res.statusCode).toBe(400);
  });
});
