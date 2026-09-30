import { prisma } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import { hashPassword } from "./password.js";

/**
 * Idempotent superAdmin seed, called directly from src/server.ts at API
 * startup (unlike modules/tenancy/bootstrap.ts's ensureBootstrapMailbox,
 * which is only ever run from a manual CLI script — verified via direct
 * read of src/server.ts, which calls buildServer() with no bootstrap call
 * at all). A CLI-only bootstrap would leave a fresh deploy with genuinely no
 * way to log in until someone remembered to run a script; auth doesn't have
 * mailbox-sync's "you already have to run something manually" precedent, so
 * this deliberately runs on every process start instead.
 *
 * No-op if BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD are unset. Only
 * CREATES — an already-existing user's password is never overwritten on
 * restart, unlike ensureBootstrapMailbox's provider-config sync behavior — a
 * superAdmin who already changed their password must never have it silently
 * reset back to the env value on the next deploy.
 */
export async function ensureBootstrapAdminUser(env: Env): Promise<void> {
  if (!env.BOOTSTRAP_ADMIN_EMAIL || !env.BOOTSTRAP_ADMIN_PASSWORD) return;

  const existing = await prisma.user.findUnique({ where: { email: env.BOOTSTRAP_ADMIN_EMAIL } });
  if (existing) return;

  const user = await prisma.user.create({
    data: {
      email: env.BOOTSTRAP_ADMIN_EMAIL,
      passwordHash: await hashPassword(env.BOOTSTRAP_ADMIN_PASSWORD),
      isSuperAdmin: true,
      status: "active",
    },
  });

  await prisma.authEvent.create({ data: { userId: user.id, eventType: "bootstrap_admin_created", payload: {} } });
}
