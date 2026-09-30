import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { resetDatabase } from "../helpers/db.js";
import { ensureBootstrapAdminUser } from "../../src/modules/auth/bootstrapAdmin.js";
import { verifyPassword } from "../../src/modules/auth/password.js";
import type { Env } from "../../src/config/env.js";

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    BOOTSTRAP_ADMIN_EMAIL: undefined,
    BOOTSTRAP_ADMIN_PASSWORD: undefined,
    ...overrides,
  } as Env;
}

describe("ensureBootstrapAdminUser", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("is a no-op when neither env var is set", async () => {
    await ensureBootstrapAdminUser(fakeEnv());
    expect(await prisma.user.count()).toBe(0);
  });

  it("creates a superAdmin User with a real password hash on first run", async () => {
    await ensureBootstrapAdminUser(fakeEnv({ BOOTSTRAP_ADMIN_EMAIL: "root@example.com", BOOTSTRAP_ADMIN_PASSWORD: "initial-password-123" }));
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "root@example.com" } });
    expect(user.isSuperAdmin).toBe(true);
    expect(user.status).toBe("active");
    await expect(verifyPassword(user.passwordHash, "initial-password-123")).resolves.toBe(true);

    const events = await prisma.authEvent.findMany({ where: { eventType: "bootstrap_admin_created" } });
    expect(events).toHaveLength(1);
  });

  it("does NOT overwrite the password on a second run, even if the env password changed", async () => {
    await ensureBootstrapAdminUser(fakeEnv({ BOOTSTRAP_ADMIN_EMAIL: "root2@example.com", BOOTSTRAP_ADMIN_PASSWORD: "original-password" }));
    await ensureBootstrapAdminUser(fakeEnv({ BOOTSTRAP_ADMIN_EMAIL: "root2@example.com", BOOTSTRAP_ADMIN_PASSWORD: "a-different-password" }));

    expect(await prisma.user.count({ where: { email: "root2@example.com" } })).toBe(1);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "root2@example.com" } });
    await expect(verifyPassword(user.passwordHash, "original-password")).resolves.toBe(true);
    await expect(verifyPassword(user.passwordHash, "a-different-password")).resolves.toBe(false);
  });
});
