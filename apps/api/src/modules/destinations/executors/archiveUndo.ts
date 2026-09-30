import type { ActionExecution } from "@prisma/client";
import { prisma } from "../../../db/client.js";
import { recordAuditEvent, AuditEventType } from "../../audit/record.js";
import { ARCHIVE_EXECUTOR_TIMEOUT_MS } from "../idempotency.js";
import { openImapSession, withTimeout, type ArchiveClientFactory } from "./imapSession.js";

/**
 * Phase 15: move an archived message back to the folder it came from.
 *
 * Only an "archive" execution that succeeded can be undone — a forward or a
 * webhook has already left the building. The undo is recorded as its own
 * ActionExecution (channelType "archive_undo", idempotency key
 * "undo:<execution id>"), so the email's history shows it and a second undo
 * of the same move is refused.
 *
 * The message is found in the target folder by the UID the server reported
 * when it was moved (if the folder's UIDVALIDITY still matches), otherwise by
 * Message-ID. Before moving it back, an IngestionSuppression is written so the
 * next sync recognizes the message (which gets a new UID) as this same email
 * instead of new mail to route again.
 *
 * Outcomes mirror the archive executor: nothing happened (connection failed
 * before the move) → failed, safe to try again; the move was sent but the
 * answer was lost → ambiguous, check the mailbox; message not there → failed
 * with an explanation.
 */
export const UNDO_CHANNEL_TYPE = "archive_undo";
const SUPPRESSION_TTL_MS = 24 * 60 * 60 * 1000;

export class UndoRefusedError extends Error {
  constructor(
    public readonly code: "not_found" | "not_undoable" | "already_undone" | "in_progress" | "not_latest",
    message: string,
  ) {
    super(message);
  }
}

export interface UndoResult {
  status: "succeeded" | "failed" | "ambiguous";
  message: string;
  execution: ActionExecution;
}

interface ArchiveMetadata {
  moved?: boolean;
  targetFolder?: string;
  sourceFolder?: string;
  targetUid?: number;
  targetUidValidity?: number;
}

export async function undoArchiveExecution(tenantId: string, executionId: string, actor: string, clientFactory?: ArchiveClientFactory): Promise<UndoResult> {
  const original = await prisma.actionExecution.findFirst({ where: { id: executionId, tenantId }, include: { email: true } });
  if (!original) throw new UndoRefusedError("not_found", `Action execution ${executionId} not found`);
  if (original.channelType !== "archive") {
    throw new UndoRefusedError("not_undoable", "Only a move to a folder can be undone. A forwarded email or a webhook call can't be taken back.");
  }
  if (original.status !== "succeeded") throw new UndoRefusedError("not_undoable", "Only a completed move can be undone.");
  const meta = (original.responseMetadata ?? {}) as ArchiveMetadata;
  if (!meta.targetFolder) throw new UndoRefusedError("not_undoable", "This move didn't record where the message went, so it can't be undone.");

  const idempotencyKey = `undo:${original.id}`;
  const previous = await prisma.actionExecution.findFirst({ where: { idempotencyKey, status: { in: ["succeeded", "pending"] } } });
  if (previous?.status === "succeeded") throw new UndoRefusedError("already_undone", "This move was already undone.");
  if (previous?.status === "pending") throw new UndoRefusedError("in_progress", "This move is being undone right now.");

  const email = original.email;

  // Moves undo in reverse order. If the email was moved again after this move
  // (and that later move wasn't undone), the message isn't where this move
  // left it: say which move to undo first instead of failing to find it.
  const laterMoves = await prisma.actionExecution.findMany({
    where: { emailId: email.id, channelType: "archive", status: "succeeded", createdAt: { gt: original.createdAt }, id: { not: original.id } },
    orderBy: { createdAt: "desc" },
  });
  if (laterMoves.length > 0) {
    const undone = new Set(
      (await prisma.actionExecution.findMany({ where: { idempotencyKey: { in: laterMoves.map((m) => `undo:${m.id}`) }, status: "succeeded" }, select: { idempotencyKey: true } })).map((u) => u.idempotencyKey.slice("undo:".length)),
    );
    const blocking = laterMoves.find((m) => !undone.has(m.id) && (m.responseMetadata as ArchiveMetadata | null)?.moved !== false);
    if (blocking) {
      const folder = (blocking.responseMetadata as ArchiveMetadata | null)?.targetFolder;
      throw new UndoRefusedError("not_latest", `The email was moved again later${folder ? ` (to "${folder}")` : ""}. Undo that move first; moves are undone newest first.`);
    }
  }

  if (!email.messageId && meta.targetUid === undefined) {
    throw new UndoRefusedError("not_undoable", "The message has no Message-ID and the server didn't report where it was moved, so it can't be found reliably.");
  }

  const mailbox = await prisma.mailboxConnection.findUnique({ where: { id: email.mailboxConnectionId } });
  const sourceFolder = meta.sourceFolder ?? (mailbox?.providerConfig as { folder?: string } | null)?.folder;
  if (!sourceFolder) throw new UndoRefusedError("not_undoable", "The mailbox this message came from no longer exists.");

  let undo: ActionExecution;
  try {
    undo = await prisma.actionExecution.create({
      data: {
        tenantId,
        emailId: email.id,
        routingDecisionId: original.routingDecisionId,
        destinationChannelId: original.destinationChannelId,
        channelType: UNDO_CHANNEL_TYPE,
        channelVersion: original.channelVersion,
        idempotencyKey,
        attemptNumber: (await prisma.actionExecution.count({ where: { idempotencyKey } })) + 1,
        status: "pending",
        requestMetadata: { undoes: original.id, fromFolder: meta.targetFolder, toFolder: sourceFolder },
      },
    });
  } catch (error) {
    // The partial unique index on pending rows: another undo of the same move won the race.
    if ((error as { code?: string }).code === "P2002") throw new UndoRefusedError("in_progress", "This move is being undone right now.");
    throw error;
  }

  const finish = async (status: UndoResult["status"], message: string, extra: Record<string, unknown> = {}, errorClass?: string): Promise<UndoResult> => {
    const execution = await prisma.actionExecution.update({
      where: { id: undo.id },
      data: {
        status,
        completedAt: new Date(),
        ...(status === "succeeded" ? { responseMetadata: { restoredTo: sourceFolder, fromFolder: meta.targetFolder, ...extra } } : { errorClass: errorClass ?? null, errorMessage: message, retryable: false }),
      },
    });
    await recordAuditEvent(prisma, {
      tenantId,
      emailId: email.id,
      eventType: status === "succeeded" ? AuditEventType.ACTION_UNDONE : AuditEventType.ACTION_UNDO_FAILED,
      actor,
      payload: { undoneExecutionId: original.id, status, fromFolder: meta.targetFolder, toFolder: sourceFolder, ...(status === "succeeded" ? extra : { message }) },
    });
    return { status, message, execution };
  };

  const session = await openImapSession(email.mailboxConnectionId, clientFactory);
  if (!session.ok) {
    const outcome = session.outcome;
    return finish("failed", outcome.status === "failed" ? outcome.errorMessage : "Could not open the mailbox", {}, "invalid_config");
  }
  const { client } = session;

  // Written before the move, so a sync that runs the instant the message
  // lands back in the folder already recognizes it.
  const suppression = await prisma.ingestionSuppression.create({
    data: { tenantId, mailboxConnectionId: email.mailboxConnectionId, emailId: email.id, messageId: email.messageId, expiresAt: new Date(Date.now() + SUPPRESSION_TTL_MS) },
  });
  const dropSuppression = () => prisma.ingestionSuppression.delete({ where: { id: suppression.id } }).catch(() => {});

  try {
    await withTimeout(client.connect(), ARCHIVE_EXECUTOR_TIMEOUT_MS, "connect");
    const status = await withTimeout(client.openMailbox(meta.targetFolder), ARCHIVE_EXECUTOR_TIMEOUT_MS, "openMailbox");

    let uid: number | null = null;
    // After a later move of this email was undone, the message came back to
    // this folder under a NEW uid — the one recorded here is stale. Only trust
    // it when nothing else moved the email since.
    const uidIsCurrent = laterMoves.length === 0;
    if (uidIsCurrent && meta.targetUid !== undefined && meta.targetUidValidity === status.uidValidity) uid = meta.targetUid;
    else if (email.messageId) uid = await withTimeout(client.findUidByMessageId(email.messageId), ARCHIVE_EXECUTOR_TIMEOUT_MS, "search");
    if (uid === null) {
      await dropSuppression();
      return finish("failed", `The message is no longer in "${meta.targetFolder}". It may have been moved or deleted by hand.`, {}, "message_not_found");
    }

    let moved;
    try {
      moved = await withTimeout(client.moveMessage(uid, sourceFolder), ARCHIVE_EXECUTOR_TIMEOUT_MS, "moveMessage");
    } catch (moveError) {
      // Sent, outcome unknown: keep the suppression (it expires on its own) in case the message did land back.
      return finish("ambiguous", `The move back may or may not have happened (${moveError instanceof Error ? moveError.message : String(moveError)}). Check "${sourceFolder}" in the mailbox.`, {}, "ambiguous");
    }
    if (moved === false) {
      await dropSuppression();
      return finish("failed", `The message is no longer in "${meta.targetFolder}". It may have been moved or deleted by hand.`, {}, "message_not_found");
    }

    if (moved.targetUid !== undefined && moved.targetUidValidity !== undefined) {
      await prisma.ingestionSuppression.update({ where: { id: suppression.id }, data: { uid: moved.targetUid, uidValidity: moved.targetUidValidity } });
      // Point the email at the message's new identity right away, so its detail
      // page and any later action refer to where it really is now.
      await prisma.email
        .update({ where: { id: email.id }, data: { externalId: String(moved.targetUid), uidValidity: moved.targetUidValidity } })
        .catch((error: { code?: string }) => {
          if (error.code !== "P2002") throw error;
        });
    }
    return finish("succeeded", `Moved back to "${sourceFolder}".`, moved.targetUid !== undefined ? { newUid: moved.targetUid } : {});
  } catch (error) {
    // Failed before the move was sent: nothing happened, safe to try again.
    await dropSuppression();
    return finish("failed", `Could not reach the mailbox: ${error instanceof Error ? error.message : String(error)}. Nothing was changed; try again.`, {}, "connection");
  } finally {
    await client.close().catch(() => {});
  }
}
