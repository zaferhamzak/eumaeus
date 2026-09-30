import { prisma } from "../../db/client.js";
import { recordAuditEvent, AuditEventType } from "../audit/record.js";
import { eraseEmails } from "../privacy/retention.js";
import { unscheduleMailboxSync } from "../../queue/mailboxSyncQueue.js";
import { logger } from "../../logger.js";

/**
 * Permanent deletion — the one place Eumaeus removes an organization or a
 * mailbox for good. Everything here deletes Eumaeus's OWN data; messages in
 * the mailboxes themselves are never touched.
 *
 *   organization   must be deactivated first (deactivation stops its mail
 *                  coming in and is reversible); then a system administrator
 *                  deletes it by typing its name. Every row it owns goes,
 *                  including its audit trail — so the deletion itself is
 *                  recorded as an AuthEvent of the administrator.
 *   mailbox        must be disabled first; deleted with its emails (and all
 *                  derived rows) by typing its address. Recorded in the
 *                  organization's audit trail.
 *   emails         selected emails of one organization (at most 100 at a
 *                  time), the same way KVKK erasure deletes them.
 */
export const MAX_EMAILS_PER_DELETE = 100;
const EMAIL_BATCH = 500;

export class DeletionError extends Error {
  constructor(
    public readonly code: "not_found" | "still_active" | "confirmation_mismatch",
    message: string,
  ) {
    super(message);
  }
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export async function reactivateOrganization(id: string, actor: string) {
  const existing = await prisma.tenant.findUnique({ where: { id } });
  if (!existing) throw new DeletionError("not_found", `Organization ${id} not found`);
  if (existing.status === "active") return existing;
  const updated = await prisma.tenant.update({ where: { id }, data: { status: "active" } });
  await recordAuditEvent(prisma, { tenantId: id, eventType: AuditEventType.ORGANIZATION_REACTIVATED, actor, payload: { organizationId: id } });
  return updated;
}

async function eraseAllEmails(where: { tenantId: string; mailboxConnectionId?: string }): Promise<number> {
  let erased = 0;
  for (;;) {
    const batch = await prisma.email.findMany({ where, select: { id: true }, take: EMAIL_BATCH });
    if (batch.length === 0) return erased;
    erased += await eraseEmails(where.tenantId, batch.map((e) => e.id));
  }
}

export interface MailboxDeletionResult {
  emailAddress: string;
  emails: number;
}

export async function deleteMailboxPermanently(tenantId: string, mailboxId: string, confirmAddress: string, actor: string): Promise<MailboxDeletionResult> {
  const mailbox = await prisma.mailboxConnection.findFirst({ where: { id: mailboxId, tenantId } });
  if (!mailbox) throw new DeletionError("not_found", `Mailbox ${mailboxId} not found`);
  if (mailbox.status === "active") throw new DeletionError("still_active", "Disable the mailbox first, then delete it.");
  if (!same(confirmAddress, mailbox.emailAddress)) throw new DeletionError("confirmation_mismatch", `Type the mailbox address (${mailbox.emailAddress}) to confirm.`);

  await unscheduleMailboxSync(mailbox.id);
  const emails = await eraseAllEmails({ tenantId, mailboxConnectionId: mailbox.id });
  await prisma.$transaction(async (tx) => {
    await tx.mailboxCredential.deleteMany({ where: { mailboxConnectionId: mailbox.id } });
    await tx.mailboxOAuthToken.deleteMany({ where: { mailboxConnectionId: mailbox.id } });
    await tx.mailboxConnection.delete({ where: { id: mailbox.id } });
    await recordAuditEvent(tx, { tenantId, eventType: AuditEventType.MAILBOX_DELETED, actor, payload: { mailboxConnectionId: mailbox.id, emailAddress: mailbox.emailAddress, emails } });
  });
  return { emailAddress: mailbox.emailAddress, emails };
}

export interface OrganizationDeletionResult {
  name: string;
  mailboxes: number;
  emails: number;
}

export async function deleteOrganizationPermanently(id: string, confirmName: string, actor: { id: string; email: string }): Promise<OrganizationDeletionResult> {
  const tenant = await prisma.tenant.findUnique({ where: { id } });
  if (!tenant) throw new DeletionError("not_found", `Organization ${id} not found`);
  if (tenant.status === "active") throw new DeletionError("still_active", "Deactivate the organization first, then delete it.");
  if (!same(confirmName, tenant.name)) throw new DeletionError("confirmation_mismatch", `Type the organization's name (${tenant.name}) to confirm.`);

  const mailboxes = await prisma.mailboxConnection.findMany({ where: { tenantId: id }, select: { id: true } });
  for (const m of mailboxes) await unscheduleMailboxSync(m.id);
  const emails = await eraseAllEmails({ tenantId: id });

  const where = { tenantId: id };
  await prisma.$transaction(
    async (tx) => {
      // Order follows the foreign keys (children before parents).
      await tx.membership.deleteMany({ where });
      await tx.apiKey.deleteMany({ where });
      await tx.tenantQuestion.deleteMany({ where });
      await tx.forwardDigestItem.deleteMany({ where });
      await tx.notifyQueueItem.deleteMany({ where });
      await tx.notifyChannelState.deleteMany({ where });
      await tx.forwardDigestBatch.deleteMany({ where });
      await tx.actionExecution.deleteMany({ where });
      await tx.ingestionSuppression.deleteMany({ where });
      await tx.humanReviewItem.deleteMany({ where });
      await tx.ruleEvaluation.deleteMany({ where });
      await tx.routingDecision.deleteMany({ where });
      await tx.analysisResult.deleteMany({ where });
      await tx.auditEvent.deleteMany({ where });
      await tx.emailSource.deleteMany({ where });
      await tx.email.deleteMany({ where });
      await tx.mailboxCredential.deleteMany({ where });
      await tx.mailboxOAuthToken.deleteMany({ where });
      await tx.mailboxConnection.deleteMany({ where });
      await tx.ruleNode.deleteMany({ where });
      await tx.ruleGraphVersion.deleteMany({ where });
      await tx.ruleGraph.deleteMany({ where });
      await tx.rule.deleteMany({ where });
      await tx.destinationSecret.deleteMany({ where });
      await tx.destinationChannel.deleteMany({ where });
      await tx.destination.deleteMany({ where });
      await tx.forwardRecipient.deleteMany({ where });
      await tx.senderListEntry.deleteMany({ where });
      await tx.routingSuggestion.deleteMany({ where });
      await tx.alert.deleteMany({ where });
      await tx.outboundEmail.deleteMany({ where });
      await tx.autoReplyRecord.deleteMany({ where });
      await tx.tenant.delete({ where: { id } });
      await tx.authEvent.create({
        data: { userId: actor.id, eventType: "organization_deleted", payload: { organizationId: id, name: tenant.name, mailboxes: mailboxes.length, emails, by: actor.email } },
      });
    },
    { timeout: 60_000 },
  );
  logger.info({ event: "organization_deleted", organizationId: id, mailboxes: mailboxes.length, emails }, "organization permanently deleted");
  return { name: tenant.name, mailboxes: mailboxes.length, emails };
}

export async function deleteEmails(tenantId: string, emailIds: string[], actor: string): Promise<{ deleted: number }> {
  const ids = [...new Set(emailIds)].slice(0, MAX_EMAILS_PER_DELETE);
  const own = await prisma.email.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true } });
  if (own.length === 0) return { deleted: 0 };
  const deleted = await eraseEmails(tenantId, own.map((e) => e.id));
  await recordAuditEvent(prisma, { tenantId, eventType: AuditEventType.EMAILS_DELETED, actor, payload: { count: deleted, emailIds: own.map((e) => e.id) } });
  return { deleted };
}
