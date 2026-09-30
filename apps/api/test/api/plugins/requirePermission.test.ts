import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { requirePermission } from "../../../src/api/plugins/requirePermission.js";
import { ForbiddenError, UnauthorizedError } from "../../../src/api/errors/ApiError.js";
import { resetDatabase } from "../../helpers/db.js";
import { createTestMembership, createTestUser } from "../../helpers/auth.js";
import { prisma } from "../../../src/db/client.js";
import type { AuthenticatedUser } from "../../../src/api/plugins/authContext.js";
import type { Membership } from "@prisma/client";

/**
 * Direct unit tests of the preHandler function requirePermission() returns —
 * NOT via a full HTTP round-trip. A synthetic `app.register()`'d probe route
 * would sit in a SEPARATE Fastify encapsulation scope from the one
 * buildServer() wires tenantContext into internally, so request.membership
 * would never actually be populated by the real plugin — hand-building the
 * FastifyRequest shape this preHandler actually reads (user, tenantId,
 * membership, params) is both simpler and a more faithful unit test of the
 * function's own logic. Route-level wiring is covered end-to-end once
 * requirePermission is applied to real routes (Phase 11 rollout step 7).
 */
function fakeRequest(overrides: Partial<Pick<FastifyRequest, "user" | "tenantId" | "membership" | "params">>): FastifyRequest {
  return {
    user: null,
    tenantId: "",
    membership: null,
    params: {},
    ...overrides,
  } as FastifyRequest;
}

describe("requirePermission", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("throws UnauthorizedError with no authenticated user", async () => {
    const check = requirePermission("rules:write");
    await expect(check(fakeRequest({ user: null }))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("superAdmin bypasses the check entirely, even with membership: null", async () => {
    const superAdmin: AuthenticatedUser = { id: "x", email: "x@example.com", isSuperAdmin: true };
    const check = requirePermission("rules:write");
    await expect(check(fakeRequest({ user: superAdmin, membership: null }))).resolves.toBeUndefined();
  });

  it("throws ForbiddenError when request.membership is null (no Membership resolved for this organization)", async () => {
    const user: AuthenticatedUser = { id: "x", email: "x@example.com", isSuperAdmin: false };
    const check = requirePermission("rules:write");
    await expect(check(fakeRequest({ user, membership: null }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("throws ForbiddenError when the Membership exists but lacks the specific required permission", async () => {
    const user = await createTestUser();
    const org = await prisma.tenant.create({ data: { name: "Org" } });
    const membership = await createTestMembership(user.id, org.id, ["rules:read"]); // NOT rules:write
    const check = requirePermission("rules:write");
    await expect(check(fakeRequest({ user: { id: user.id, email: user.email, isSuperAdmin: false }, membership }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("resolves when the Membership has the exact required permission", async () => {
    const user = await createTestUser();
    const org = await prisma.tenant.create({ data: { name: "Org" } });
    const membership = await createTestMembership(user.id, org.id, ["rules:write"]);
    const check = requirePermission("rules:write");
    await expect(check(fakeRequest({ user: { id: user.id, email: user.email, isSuperAdmin: false }, membership }))).resolves.toBeUndefined();
  });

  it("throws ForbiddenError for a PENDING or REVOKED membership even if it lists the permission", async () => {
    const user = await createTestUser();
    const org = await prisma.tenant.create({ data: { name: "Org" } });
    const pending = await createTestMembership(user.id, org.id, ["rules:write"], "pending");
    const check = requirePermission("rules:write");
    await expect(check(fakeRequest({ user: { id: user.id, email: user.email, isSuperAdmin: false }, membership: pending }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  describe("paramName mode — target organization is a URL param, not request.tenantId/membership", () => {
    it("ignores request.membership entirely and looks up the param's organization instead", async () => {
      const user = await createTestUser();
      const orgA = await prisma.tenant.create({ data: { name: "Org A" } });
      const orgB = await prisma.tenant.create({ data: { name: "Org B" } });
      const membershipInA = await createTestMembership(user.id, orgA.id, ["organizations:write"]);
      const check = requirePermission("organizations:write", { paramName: "id" });

      // request.membership is set to orgA's (as if the header pointed at A),
      // but the URL param names org B — must be forbidden regardless.
      await expect(
        check(fakeRequest({ user: { id: user.id, email: user.email, isSuperAdmin: false }, membership: membershipInA as Membership, params: { id: orgB.id } })),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("grants access when a real Membership matches the URL param's organization", async () => {
      const user = await createTestUser();
      const org = await prisma.tenant.create({ data: { name: "Org" } });
      await createTestMembership(user.id, org.id, ["organizations:write"]);
      const check = requirePermission("organizations:write", { paramName: "id" });

      await expect(
        check(fakeRequest({ user: { id: user.id, email: user.email, isSuperAdmin: false }, membership: null, params: { id: org.id } })),
      ).resolves.toBeUndefined();
    });

    it("throws ForbiddenError when the URL param is missing entirely", async () => {
      const user: AuthenticatedUser = { id: "x", email: "x@example.com", isSuperAdmin: false };
      const check = requirePermission("organizations:write", { paramName: "id" });
      await expect(check(fakeRequest({ user, params: {} }))).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});
