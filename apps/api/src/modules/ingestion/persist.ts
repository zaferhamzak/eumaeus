import type { Email, Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { recordAuditEvent, AuditEventType } from "../audit/record.js";
import { enqueueProcessEmail } from "../../queue/queues.js";
import { EmailState } from "../../types/email-state.js";
import type { NormalizedEmail } from "../../types/normalized-email.js";
import { metrics } from "../../metrics/metrics.js";
import { MetricName } from "../../metrics/names.js";
import { getSystemSettings } from "../settings/systemSettings.js";

/**
 * Larger sources aren't kept (the forward executor falls back to the stored
 * bodies for them). 25 MB is the common SMTP message-size ceiling — a source
 * bigger than that couldn't be forwarded intact anyway.
 */
export const MAX_STORED_SOURCE_BYTES = 25 * 1024 * 1024;

export interface PersistResult {
  email: Email;
  /** Whether this call inserted a new row (false = the message was already known). */
  created: boolean;
  /** Phase 15: the message is one Eumaeus moved back (an undone archive); it was linked to its existing Email and not processed again. */
  restoredAfterUndo?: boolean;
}

/**
 * The idempotency boundary described in implementation-plan.md §G.
 *
 * Turns a NormalizedEmail into a durable Email row exactly once, no matter how many
 * times this function is called for the same message — across retried sync runs,
 * IMAP reconnects, or the same UID being discovered twice in one sync pass.
 *
 * The guarantee comes from the database, not from this function's logic: the
 * `mailbox_message_identity` unique constraint on (mailboxConnectionId, uidValidity,
 * externalId) is what actually prevents a duplicate row, even under concurrent
 * callers. This function's job is to detect that case cleanly and still make sure
 * the email ends up queued for processing (see enqueue note below).
 */
export async function persistNormalizedEmail(
  tenantId: string,
  mailboxConnectionId: string,
  normalized: NormalizedEmail,
): Promise<PersistResult> {
  // Read before the transaction (it may hit the DB on a cold cache) — the
  // retention window only decides whether/how long to keep the raw source.
  const retentionDays = normalized.rawSource ? (await getSystemSettings()).rawSourceRetentionDays : 0;

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.email.findUnique({
      where: {
        mailbox_message_identity: {
          mailboxConnectionId,
          uidValidity: normalized.uidValidity,
          externalId: normalized.externalId,
        },
      },
    });

    const now = new Date();

    // Phase 15: a message moved back by an undo reappears here. Link it to its
    // existing Email instead of treating it as new mail (see IngestionSuppression).
    const suppression = await tx.ingestionSuppression.findFirst({
      where: {
        mailboxConnectionId,
        consumedAt: null,
        expiresAt: { gt: now },
        OR: [
          ...(existing ? [{ emailId: existing.id }] : []),
          { uidValidity: normalized.uidValidity, uid: Number(normalized.externalId) },
          ...(normalized.messageId ? [{ messageId: normalized.messageId }] : []),
        ],
      },
      orderBy: { createdAt: "desc" },
    });
    if (suppression) {
      await tx.ingestionSuppression.update({ where: { id: suppression.id }, data: { consumedAt: now } });
      const email = existing ?? (await tx.email.update({ where: { id: suppression.emailId }, data: { externalId: normalized.externalId, uidValidity: normalized.uidValidity } }));
      await recordAuditEvent(tx, {
        tenantId,
        emailId: email.id,
        eventType: AuditEventType.EMAIL_RESTORED_AFTER_UNDO,
        actor: "system",
        payload: { externalId: normalized.externalId, uidValidity: normalized.uidValidity },
      });
      return { email, created: false, restoredAfterUndo: true };
    }

    if (existing) {
      return { email: existing, created: false };
    }

    const email = await tx.email.create({
      data: {
        tenantId,
        mailboxConnectionId,
        provider: normalized.provider,
        externalId: normalized.externalId,
        uidValidity: normalized.uidValidity,
        messageId: normalized.messageId,
        fromAddress: normalized.from,
        toAddresses: normalized.to,
        ccAddresses: normalized.cc,
        bccAddresses: normalized.bcc,
        subject: normalized.subject,
        receivedAt: normalized.receivedAt,
        textBody: normalized.textBody,
        htmlBody: normalized.htmlBody,
        hasAttachments: normalized.hasAttachments,
        attachmentMeta: normalized.attachments as unknown as Prisma.InputJsonValue,
        forwardedByEumaeus: normalized.forwardedByEumaeus ?? false,
        ...(normalized.replyHeaders
          ? {
              headersCaptured: true,
              autoSubmitted: normalized.replyHeaders.autoSubmitted ?? null,
              precedence: normalized.replyHeaders.precedence ?? null,
              listId: normalized.replyHeaders.listId ?? null,
              replyToAddress: normalized.replyHeaders.replyTo ?? null,
              senderName: normalized.replyHeaders.senderName ?? null,
              threadHeadersCaptured: true,
              inReplyTo: normalized.replyHeaders.inReplyTo ?? null,
              references: normalized.replyHeaders.references ?? null,
            }
          : {}),
        ...(normalized.senderAuth !== undefined
          ? { senderAuthCaptured: true, ...(normalized.senderAuth ? { senderAuth: normalized.senderAuth as unknown as Prisma.InputJsonValue } : {}) }
          : {}),
        state: EmailState.RECEIVED,
        stateUpdatedAt: now,
        ingestedAt: now,
      },
    });

    // Same transaction as the Email row: an email either has its source (when
    // one was supplied and retention is on) or was never created at all.
    if (normalized.rawSource && retentionDays > 0 && normalized.rawSource.length <= MAX_STORED_SOURCE_BYTES) {
      await tx.emailSource.create({
        data: {
          emailId: email.id,
          tenantId,
          source: new Uint8Array(normalized.rawSource),
          sizeBytes: normalized.rawSource.length,
          expiresAt: new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000),
        },
      });
    }

    await recordAuditEvent(tx, {
      tenantId,
      emailId: email.id,
      eventType: AuditEventType.EMAIL_DISCOVERED,
      actor: "system",
      payload: {
        provider: normalized.provider,
        externalId: normalized.externalId,
        uidValidity: normalized.uidValidity,
        messageId: normalized.messageId ?? null,
        from: normalized.from,
        subject: normalized.subject ?? null,
      },
    });

    return { email, created: true };
  });

  // Enqueue unconditionally, not only `if (result.created)`. If a previous run
  // inserted the row but crashed before enqueueing (or before this line ran), a
  // later call for the same message must still get it queued. BullMQ's jobId
  // dedup (jobId = emailId, see queue/queues.ts) makes this call a safe no-op when
  // a job for this email is already queued/active — that's what makes "enqueue
  // every time" correct instead of a source of duplicate jobs.
  if (result.created) {
    await recordAuditEvent(prisma, {
      tenantId,
      emailId: result.email.id,
      eventType: AuditEventType.EMAIL_QUEUED_FOR_PROCESSING,
      actor: "system",
    });
    metrics.increment(MetricName.EMAILS_RECEIVED);
  }
  // A restored message was already fully processed before its move was undone.
  if (!result.restoredAfterUndo) await enqueueProcessEmail(result.email.id);

  return result;
}
