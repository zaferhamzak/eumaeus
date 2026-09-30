import { prisma } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import { setMailboxCredential } from "../mail-providers/imap/mailboxCredentials.js";

/**
 * Phase 1 has no signup UI or OAuth-style connection flow — the single mailbox is
 * described entirely by env vars (MAIL_HOST etc., see .env.example). This function
 * turns that env config into the DB rows the rest of the system (Tenant,
 * MailboxConnection) expects to exist, so ingestion code never has to special-case
 * "there might not be a tenant yet."
 *
 * Idempotent: safe to call on every process start. Finds-or-creates by
 * (tenant name) and (tenant + email address) rather than blindly inserting.
 *
 * Phase 10: this is also the legacy migration path — MAIL_PASSWORD is now
 * upserted into a real MailboxCredential row (encrypted, via the same
 * mechanism every other mailbox uses — see mailboxCredentials.ts) EVERY time
 * this runs, so the .env-configured legacy mailbox keeps working exactly as
 * before (env stays authoritative for THIS one mailbox specifically, same as
 * it always was) while every OTHER mailbox created through the API is
 * completely independent of it. No manual migration step is required.
 */
export async function ensureBootstrapMailbox(env: Env) {
  if (!env.MAIL_HOST || !env.MAIL_USERNAME || !env.MAIL_PASSWORD) {
    throw new Error("The legacy bootstrap mailbox needs MAIL_HOST, MAIL_USERNAME and MAIL_PASSWORD in .env. (Mailboxes are normally added in the app instead.)");
  }
  const mail = { host: env.MAIL_HOST, username: env.MAIL_USERNAME, password: env.MAIL_PASSWORD };
  const tenant =
    (await prisma.tenant.findFirst({ where: { name: env.DEFAULT_TENANT_NAME } })) ??
    (await prisma.tenant.create({ data: { name: env.DEFAULT_TENANT_NAME } }));

  const emailAddress = mail.username;

  const existing = await prisma.mailboxConnection.findFirst({
    where: { tenantId: tenant.id, provider: "imap", emailAddress },
  });

  let mailboxConnection: Awaited<ReturnType<typeof prisma.mailboxConnection.create>>;

  if (existing) {
    // Keep non-secret connection config in sync with env in case it changed between
    // runs (host/port/tls/folder) — this is the only mutable part of providerConfig.
    mailboxConnection = await prisma.mailboxConnection.update({
      where: { id: existing.id },
      data: {
        providerConfig: {
          host: mail.host,
          port: env.MAIL_PORT,
          tls: env.MAIL_TLS,
          folder: env.MAIL_FOLDER,
          username: mail.username,
        },
      },
    });
  } else {
    mailboxConnection = await prisma.mailboxConnection.create({
      data: {
        tenantId: tenant.id,
        name: env.DEFAULT_TENANT_NAME,
        provider: "imap",
        emailAddress,
        providerConfig: {
          host: mail.host,
          port: env.MAIL_PORT,
          tls: env.MAIL_TLS,
          folder: env.MAIL_FOLDER,
          username: mail.username,
        },
        status: "active",
      },
    });
  }

  await setMailboxCredential(tenant.id, mailboxConnection.id, mail.password);

  return { tenant, mailboxConnection };
}
