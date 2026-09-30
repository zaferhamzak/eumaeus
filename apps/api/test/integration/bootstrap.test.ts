import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/db/client.js";
import { ensureBootstrapMailbox } from "../../src/modules/tenancy/bootstrap.js";
import { resolveMailboxPassword } from "../../src/modules/mail-providers/imap/mailboxCredentials.js";
import type { Env } from "../../src/config/env.js";

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: "postgresql://unused",
    REDIS_URL: "redis://unused",
    DEFAULT_TENANT_NAME: "Legacy Bootstrap Tenant",
    MAIL_HOST: "mail.legacy.test",
    MAIL_PORT: 993,
    MAIL_TLS: true,
    MAIL_USERNAME: "legacy@example.com",
    MAIL_PASSWORD: "legacy-env-password",
    MAIL_FOLDER: "INBOX",
    MAIL_INITIAL_SYNC_LIMIT: undefined,
    MAIL_SYNC_INTERVAL_SECONDS: 60,
    JEV_API_KEY: "unused",
    JEV_MODEL_VERSION: "unused",
    JEV_API_BASE_URL: "https://unused.invalid",
    JEV_TIMEOUT_MS: 30000,
    SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    WEBHOOK_TIMEOUT_MS: 10000,
    API_PORT: 3000,
    API_HOST: "0.0.0.0",
    RATE_LIMIT_PER_MINUTE: 300,
    WORKER_WATCHDOG_MINUTES: 5,
    MAIL_IDLE_ENABLED: false,
    MAIL_POLL_FALLBACK_SECONDS: 300,
    MAIL_IDLE_MAX_CONNECTIONS: 50,
    SYSTEM_ALERT_EMAILS: [],
    SYSTEM_ALERT_LOCALE: "en",
    SHUTDOWN_GRACE_PERIOD_MS: 15000,
    SESSION_TTL_SECONDS: 86400,
    SESSION_COOKIE_NAME: "jm_session",
    SESSION_COOKIE_SECURE: true,
    BOOTSTRAP_ADMIN_EMAIL: undefined,
    BOOTSTRAP_ADMIN_PASSWORD: undefined,
    APP_BASE_URL: "http://localhost:3001",
    SMTP_HOST: undefined,
    SMTP_PORT: 587,
    SMTP_SECURE: false,
    SMTP_USERNAME: undefined,
    SMTP_PASSWORD: undefined,
    SMTP_FROM_ADDRESS: undefined,
    SMTP_FROM_NAME: "Eumaeus",
    ...overrides,
  };
}

/**
 * Regression coverage for Phase 10's "LEGACY COMPATIBILITY" requirement: the
 * .env-configured single mailbox must keep working automatically, with no
 * manual migration step, and without ever creating a duplicate mailbox.
 */
describe("ensureBootstrapMailbox — legacy .env mailbox migration (Phase 10)", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("creates the Tenant, MailboxConnection, AND a real encrypted MailboxCredential from env — automatically, no manual step", async () => {
    const env = fakeEnv();
    const { tenant, mailboxConnection } = await ensureBootstrapMailbox(env);

    expect(tenant.name).toBe("Legacy Bootstrap Tenant");
    expect(mailboxConnection.emailAddress).toBe("legacy@example.com");

    const credential = await prisma.mailboxCredential.findUnique({ where: { mailboxConnectionId: mailboxConnection.id } });
    expect(credential).not.toBeNull();
    expect(credential!.encryptedValue).not.toContain("legacy-env-password");

    const resolved = await resolveMailboxPassword(tenant.id, mailboxConnection.id);
    expect(resolved).toBe("legacy-env-password");
  });

  it("calling it twice in a row does NOT create a duplicate tenant or mailbox", async () => {
    const env = fakeEnv();
    await ensureBootstrapMailbox(env);
    await ensureBootstrapMailbox(env);

    expect(await prisma.tenant.count()).toBe(1);
    expect(await prisma.mailboxConnection.count()).toBe(1);
    expect(await prisma.mailboxCredential.count()).toBe(1);
  });

  it("if MAIL_PASSWORD changes between runs, the credential is updated to match — env stays authoritative for THIS one legacy mailbox specifically", async () => {
    await ensureBootstrapMailbox(fakeEnv({ MAIL_PASSWORD: "first-password" }));
    const { tenant, mailboxConnection } = await ensureBootstrapMailbox(fakeEnv({ MAIL_PASSWORD: "rotated-password" }));

    expect(await resolveMailboxPassword(tenant.id, mailboxConnection.id)).toBe("rotated-password");
  });

  it("a mailbox created independently through the API is NOT affected by re-running the legacy bootstrap", async () => {
    const env = fakeEnv();
    const { tenant } = await ensureBootstrapMailbox(env);

    const { createMailboxConnection } = await import("../../src/modules/mail-providers/imap/manageMailboxConnections.js");
    const apiMailbox = await createMailboxConnection(tenant.id, {
      name: "API Mailbox",
      emailAddress: "api@example.com",
      host: "imap-api.example.com",
      port: 993,
      tls: true,
      folder: "INBOX",
      username: "api@example.com",
      password: "api-mailbox-password",
    });

    await ensureBootstrapMailbox(env); // re-run, as if the process restarted

    expect(await resolveMailboxPassword(tenant.id, apiMailbox.id)).toBe("api-mailbox-password");
    expect(await prisma.mailboxConnection.count()).toBe(2); // legacy + API mailbox, both intact
  });
});
