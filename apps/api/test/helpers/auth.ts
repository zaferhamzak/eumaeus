import { prisma } from "../../src/db/client.js";
import { hashPassword } from "../../src/modules/auth/password.js";
import type { Permission } from "../../src/modules/auth/permissions.js";
import type { AuthResolver } from "../../src/api/plugins/authContext.js";

/** For the handful of test files that call buildServer() directly (bypassing buildTestServer's own default) and just need "logged in, sees everything" — a fixed synthetic superAdmin, same shape as buildTestServer's internal default. */
export const SUPERADMIN_TEST_AUTH_RESOLVER: AuthResolver = async () => ({
  id: "test-super-admin",
  email: "test-super-admin@internal.test",
  isSuperAdmin: true,
});

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}+${counter}@test.eumaeus.invalid`;
}

/** Real User row with a real (but test-only, never asserted against) password hash. */
export async function createTestUser(overrides: { email?: string; isSuperAdmin?: boolean; status?: string } = {}) {
  return prisma.user.create({
    data: {
      email: overrides.email ?? uniqueEmail("user"),
      passwordHash: await hashPassword("test-password-not-real"),
      isSuperAdmin: overrides.isSuperAdmin ?? false,
      status: overrides.status ?? "active",
    },
  });
}

export async function createTestSuperAdmin(overrides: { email?: string } = {}) {
  return createTestUser({ ...overrides, isSuperAdmin: true });
}

/** Real, active Membership granting exactly the given permissions — the seam requirePermission.test.ts / tenantContext.test.ts use to exercise real (non-superAdmin) permission enforcement. */
export async function createTestMembership(userId: string, tenantId: string, permissions: Permission[], status: "pending" | "active" | "revoked" = "active") {
  return prisma.membership.create({
    data: { userId, tenantId, permissions, status },
  });
}
