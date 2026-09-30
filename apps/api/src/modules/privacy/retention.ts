import { createHash } from "node:crypto";
import { prisma } from "../../db/client.js";
import { recordAuditEvent, AuditEventType } from "../audit/record.js";

/**
 * Phase 20: data retention and KVKK/GDPR erasure. Everything here deletes
 * Eumaeus's OWN copy of an email — the message in the mailbox itself is
 * never touched.
 *
 *   body retention    after Tenant.bodyRetentionDays the text and HTML bodies
 *                     and the raw source are removed; subject, sender,
 *                     analysis, decision and actions stay (the email page and
 *                     reports keep working). Email.bodyPurgedAt is set.
 *   email retention   after Tenant.emailRetentionDays the email and every row
 *                     derived from it are deleted.
 *   sender erasure    on request, every email from (or replying-to) one
 *                     address is deleted the same way, at once.
 *
 * Audit events that pointed at an erased email are kept but reduced to ids:
 * the payload becomes { erased: true, emailId } and the link is cleared, so
 * the trail shows that something happened without keeping the content.
 */
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;
const ERASE_BATCH = 500;

/** Deletes the given emails of one organization and everything derived from them. Returns how many emails were deleted. */
export async function eraseEmails(tenantId: string, emailIds: string[]): Promise<number> {
  if (emailIds.length === 0) return 0;
  return prisma.$transaction(async (tx) => {
    const where = { tenantId, emailId: { in: emailIds } };
    await tx.forwardDigestItem.deleteMany({ where });
    await tx.ingestionSuppression.deleteMany({ where });
    await tx.emailSource.deleteMany({ where: { emailId: { in: emailIds } } });
    await tx.actionExecution.deleteMany({ where });
    await tx.humanReviewItem.deleteMany({ where });
    await tx.ruleEvaluation.deleteMany({ where });
    await tx.routingDecision.deleteMany({ where });
    await tx.analysisResult.deleteMany({ where });
    await tx.$executeRaw`
      UPDATE audit_event SET payload = jsonb_build_object('erased', true, 'emailId', email_id), email_id = NULL
      WHERE tenant_id = ${tenantId} AND email_id = ANY(${emailIds}::text[])`;
    const deleted = await tx.email.deleteMany({ where: { tenantId, id: { in: emailIds } } });
    return deleted.count;
  });
}

export interface RetentionResult {
  bodiesPurged: number;
  emailsDeleted: number;
}

/** One maintenance tick: applies every active organization's retention settings. Deletes at most a few batches per organization per tick. */
export async function applyRetention(now: Date = new Date(), maxBatches = 10): Promise<RetentionResult> {
  const tenants = await prisma.tenant.findMany({
    where: { status: "active", OR: [{ bodyRetentionDays: { not: null } }, { emailRetentionDays: { not: null } }] },
    select: { id: true, bodyRetentionDays: true, emailRetentionDays: true },
  });
  const result: RetentionResult = { bodiesPurged: 0, emailsDeleted: 0 };

  for (const t of tenants) {
    if (t.emailRetentionDays) {
      const cutoff = new Date(now.getTime() - t.emailRetentionDays * DAY_MS);
      for (let i = 0; i < maxBatches; i += 1) {
        const batch = await prisma.email.findMany({ where: { tenantId: t.id, receivedAt: { lt: cutoff } }, select: { id: true }, take: ERASE_BATCH });
        result.emailsDeleted += await eraseEmails(t.id, batch.map((e) => e.id));
        if (batch.length < ERASE_BATCH) break;
      }
    }
    if (t.bodyRetentionDays) {
      const cutoff = new Date(now.getTime() - t.bodyRetentionDays * DAY_MS);
      await prisma.emailSource.deleteMany({ where: { email: { tenantId: t.id, receivedAt: { lt: cutoff } } } });
      const purged = await prisma.email.updateMany({
        where: { tenantId: t.id, receivedAt: { lt: cutoff }, bodyPurgedAt: null },
        data: { textBody: null, htmlBody: null, bodyPurgedAt: now },
      });
      result.bodiesPurged += purged.count;
    }
  }
  return result;
}

export interface SenderErasureResult {
  dryRun: boolean;
  address: string;
  emails: number;
  autoReplyRecords: number;
  suggestions: number;
  /** Block/allow list entries naming this address. They are configuration, so they're reported, not deleted. */
  senderListEntries: number;
}

export class ErasureError extends Error {}

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * KVKK/GDPR request: removes every email this organization holds from the
 * address (as sender or Reply-To), with everything derived from it, plus the
 * auto-reply history and allow/block suggestions naming it. The audit event
 * stores only a hash of the address, never the address itself.
 */
export async function eraseSender(tenantId: string, rawAddress: string, options: { dryRun: boolean }, actor?: string): Promise<SenderErasureResult> {
  const address = rawAddress.trim().toLowerCase();
  if (!ADDRESS.test(address)) throw new ErasureError(`"${rawAddress}" is not an email address`);

  const match = { tenantId, OR: [{ fromAddress: { equals: address, mode: "insensitive" as const } }, { replyToAddress: { equals: address, mode: "insensitive" as const } }] };
  const [emails, autoReplyRecords, suggestions, senderListEntries] = await Promise.all([
    prisma.email.count({ where: match }),
    prisma.autoReplyRecord.count({ where: { tenantId, recipient: address } }),
    prisma.routingSuggestion.count({ where: { tenantId, pattern: address } }),
    prisma.senderListEntry.count({ where: { tenantId, pattern: address } }),
  ]);
  const result: SenderErasureResult = { dryRun: options.dryRun, address, emails, autoReplyRecords, suggestions, senderListEntries };
  if (options.dryRun) return result;

  let erased = 0;
  for (;;) {
    const batch = await prisma.email.findMany({ where: match, select: { id: true }, take: ERASE_BATCH });
    if (batch.length === 0) break;
    erased += await eraseEmails(tenantId, batch.map((e) => e.id));
  }
  await prisma.autoReplyRecord.deleteMany({ where: { tenantId, recipient: address } });
  await prisma.routingSuggestion.deleteMany({ where: { tenantId, pattern: address } });
  await recordAuditEvent(prisma, {
    tenantId,
    eventType: AuditEventType.PRIVACY_SENDER_ERASED,
    actor: actor ?? "system",
    payload: { addressSha256: createHash("sha256").update(address).digest("hex"), emails: erased, autoReplyRecords, suggestions },
  });
  return { ...result, emails: erased };
}
