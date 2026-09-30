import { randomBytes } from "node:crypto";

// Runs once per test file, before that file's own imports execute. Two jobs:
//   1. Point Prisma at the dedicated test database (never the dev one).
//   2. Fill in placeholder MAIL_* values so env.ts's zod schema doesn't reject an
//      otherwise-valid test run — no test in this suite ever makes a real IMAP
//      connection (all use FakeImapClient), so these values are never dialed.
if (process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}
// Never the live Redis: tests enqueue, clean and obliterate BullMQ queues, and a
// running dev worker would otherwise grab test jobs (the old "locked by another
// worker" failures) — or a test would wipe the live schedules. REDIS_URL_TEST
// wins; otherwise the same server's database 15.
{
  const base = process.env.REDIS_URL_TEST ?? process.env.REDIS_URL ?? "redis://localhost:6379";
  const url = new URL(base);
  if (!process.env.REDIS_URL_TEST) url.pathname = "/15";
  process.env.REDIS_URL = url.toString();
}
// Force-set (not `??=`): vitest.config.ts loads the developer's real .env first,
// which may contain empty-string MAIL_* placeholders (present but falsy-invalid,
// not undefined) — `??=` would leave those empty strings in place. Tests must
// always get known-good fake values regardless of what's in .env.
process.env.MAIL_HOST = "imap.test.invalid";
process.env.MAIL_USERNAME = "test@test.invalid";
process.env.MAIL_PASSWORD = "test-password-not-real";
process.env.MAIL_FOLDER = "INBOX";
delete process.env.MAIL_INITIAL_SYNC_LIMIT;

// No test in this suite ever calls the real Jev API (all use an injected fake
// JevClient) — this key exists only so env.ts's required-field validation passes.
process.env.JEV_API_KEY = "test-jev-key-not-real";
process.env.JEV_MODEL_VERSION = "jev-1.13.0";
process.env.JEV_API_BASE_URL = "https://jev.test.invalid";
process.env.JEV_TIMEOUT_MS = "30000";

// Phase 5B: a fresh random (but valid — exactly 32 bytes, base64-encoded) key per
// test run. No test asserts a specific key value, only that encrypt/decrypt round
// trips and that env validation accepts a well-formed key — a random one is both
// safer (never a hardcoded "real-looking" secret in source) and sufficient.
process.env.SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.WEBHOOK_TIMEOUT_MS = "10000";

// Phase 11.1: force-cleared so tests never pick up real SMTP credentials the
// developer may have added to their own .env — isMailerConfigured() must
// consistently read as false in this suite (no test in this suite ever
// sends a real email; mailer.ts's own contract treats "not configured" as a
// normal, expected state).
delete process.env.SMTP_HOST;
delete process.env.SMTP_USERNAME;
delete process.env.SMTP_PASSWORD;

// 1.1: system emails (the worker watchdog) go to SYSTEM_ALERT_EMAILS when it
// is set; a developer's own .env may name real people there.
delete process.env.SYSTEM_ALERT_EMAILS;
delete process.env.SYSTEM_ALERT_LOCALE;
