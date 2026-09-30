import { prisma } from "../../../db/client.js";
import { encryptSecret, decryptSecret } from "../../secrets/secretCrypto.js";
import { recordAuditEvent, AuditEventType } from "../../audit/record.js";

export class MailboxCredentialError extends Error {}

/**
 * Creates or replaces a mailbox's password — mirrors
 * modules/destinations/manageSecrets.ts's setDestinationSecret() exactly
 * (same encryption, same "returns nothing sensitive, the plaintext passed in
 * is never echoed back"), simplified to the 1:1 shape MailboxCredential uses
 * (one credential per mailbox, no `name`). The audit payload is deliberately
 * `{ mailboxConnectionId }` only — never the plaintext or ciphertext.
 */
export async function setMailboxCredential(tenantId: string, mailboxConnectionId: string, plaintext: string): Promise<void> {
  if (!plaintext) throw new MailboxCredentialError("password must not be empty");

  const mailbox = await prisma.mailboxConnection.findFirst({ where: { id: mailboxConnectionId, tenantId } });
  if (!mailbox) throw new MailboxCredentialError(`no mailbox "${mailboxConnectionId}" exists for this organization`);

  const encryptedValue = encryptSecret(plaintext);
  await prisma.mailboxCredential.upsert({
    where: { mailboxConnectionId },
    create: { tenantId, mailboxConnectionId, encryptedValue },
    update: { encryptedValue },
  });

  await recordAuditEvent(prisma, {
    tenantId,
    eventType: AuditEventType.MAILBOX_CREDENTIAL_SET,
    actor: "system",
    payload: { mailboxConnectionId },
  });
}

/**
 * INTERNAL — resolves a mailbox's PLAINTEXT password. Called from exactly
 * one place: modules/mail-providers/imap/sync.ts, immediately before opening
 * an IMAP connection, and the returned string must never be retained,
 * logged, or written to any audit/response/error field beyond that single
 * use. Deterministic, tenant-scoped lookup — a missing credential (never
 * configured, or belongs to a different tenant/mailbox) is a single,
 * explicit configuration error, exactly mirroring
 * resolveDestinationSecretPlaintext()'s failure shape.
 */
export async function resolveMailboxPassword(tenantId: string, mailboxConnectionId: string): Promise<string> {
  const row = await prisma.mailboxCredential.findFirst({ where: { tenantId, mailboxConnectionId } });
  if (!row) {
    throw new MailboxCredentialError(`no credential is configured for mailbox "${mailboxConnectionId}"`);
  }
  return decryptSecret(row.encryptedValue);
}
