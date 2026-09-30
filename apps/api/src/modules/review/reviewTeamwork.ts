import { prisma } from "../../db/client.js";
import { recordAuditEvent, AuditEventType } from "../audit/record.js";
import { notifyAssignee } from "./assignmentNotify.js";
import { logger } from "../../logger.js";

/**
 * Phase 28: working the Human Review queue as a team.
 *
 *   - an item can be assigned to one member who can decide it (holds
 *     reviews:resolve in the organization) — or unassigned;
 *   - anyone who can decide can leave a note on it.
 *
 * Both are audit events on the item's email (who, when, what), and notes
 * live ONLY there: the audit log is the record, not a second table that
 * could drift from it.
 */
export const MAX_NOTE_LENGTH = 2000;

export class TeamworkError extends Error {
  constructor(
    public readonly code: "not_found" | "not_a_reviewer",
    message: string,
  ) {
    super(message);
  }
}

export interface Reviewer {
  userId: string;
  email: string;
}

/** Members of the organization who can decide review items. */
export async function listReviewers(tenantId: string): Promise<Reviewer[]> {
  const rows = await prisma.membership.findMany({
    where: { tenantId, status: "active", permissions: { has: "reviews:resolve" }, user: { status: "active" } },
    select: { user: { select: { id: true, email: true } } },
    orderBy: { user: { email: "asc" } },
  });
  return rows.map((r) => ({ userId: r.user.id, email: r.user.email }));
}

export async function assignReviewItem(tenantId: string, itemId: string, userId: string | null, actor: string) {
  const item = await prisma.humanReviewItem.findFirst({ where: { id: itemId, tenantId } });
  if (!item) throw new TeamworkError("not_found", `Review item ${itemId} not found`);
  let assignee: Reviewer | null = null;
  if (userId) {
    assignee = (await listReviewers(tenantId)).find((r) => r.userId === userId) ?? null;
    if (!assignee) throw new TeamworkError("not_a_reviewer", "That person can't decide review items in this organization.");
  }
  if (item.assignedTo === (assignee?.userId ?? null)) return item;
  const now = new Date();
  // Taking an item yourself needs no email about it.
  const selfAssigned = assignee !== null && assignee.email.toLowerCase() === actor.toLowerCase();
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.humanReviewItem.update({
      where: { id: item.id },
      data: { assignedTo: assignee?.userId ?? null, assignedAt: assignee ? now : null, assignmentNotifiedAt: selfAssigned ? now : null },
    });
    await recordAuditEvent(tx, {
      tenantId,
      emailId: item.emailId,
      eventType: AuditEventType.REVIEW_ASSIGNED,
      actor,
      payload: { reviewItemId: item.id, assignedTo: assignee?.userId ?? null, assignedToEmail: assignee?.email ?? null, previous: item.assignedTo },
    });
    return row;
  });
  // The email is a courtesy: a failure never undoes the assignment (the review-digest tick retries it).
  if (assignee && !selfAssigned) {
    await notifyAssignee(tenantId, assignee.userId).catch((error) => logger.warn({ event: "assignment_notify_failed", organizationId: tenantId, err: error }, "assignment email failed"));
  }
  return updated;
}

export interface ReviewNote {
  id: string;
  text: string;
  author: string;
  createdAt: string;
}

export async function addReviewNote(tenantId: string, itemId: string, text: string, actor: string): Promise<ReviewNote> {
  const item = await prisma.humanReviewItem.findFirst({ where: { id: itemId, tenantId } });
  if (!item) throw new TeamworkError("not_found", `Review item ${itemId} not found`);
  const note = text.trim().slice(0, MAX_NOTE_LENGTH);
  // Written straight to the audit log (recordAuditEvent returns nothing; the note needs its row back).
  const event = await prisma.auditEvent.create({
    data: { tenantId, emailId: item.emailId, eventType: AuditEventType.REVIEW_NOTE_ADDED, actor, payload: { reviewItemId: item.id, text: note } },
  });
  return { id: event.id, text: note, author: actor, createdAt: event.createdAt.toISOString() };
}

/** An item's notes, oldest first. */
export async function listReviewNotes(tenantId: string, itemId: string): Promise<ReviewNote[]> {
  const events = await prisma.auditEvent.findMany({
    where: { tenantId, eventType: AuditEventType.REVIEW_NOTE_ADDED, payload: { path: ["reviewItemId"], equals: itemId } },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  return events.map((e) => ({ id: e.id, text: String((e.payload as { text?: unknown }).text ?? ""), author: e.actor, createdAt: e.createdAt.toISOString() }));
}

/** userId → email for a page of items' assignees. */
export async function assigneeEmails(userIds: Array<string | null>): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } });
  return new Map(users.map((u) => [u.id, u.email]));
}
