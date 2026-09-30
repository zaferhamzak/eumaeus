import type { HumanReviewItem } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { recordAuditEvent, AuditEventType } from "../audit/record.js";
import { EmailState } from "../../types/email-state.js";

/** The only real, closed set of resolution classifications — mirrors every other "no DB enum, small closed vocabulary" string field in this codebase (Email.state, ActionExecution.status, ...). */
export const REVIEW_RESOLUTIONS = ["approved", "spam"] as const;
export type ReviewResolution = (typeof REVIEW_RESOLUTIONS)[number];

export class ReviewResolutionError extends Error {}

/**
 * Phase 6's `POST /api/v1/reviews/:id/resolve` (brief §15: "Resolve should be
 * deterministic and idempotent... Do NOT invent a complex approval workflow
 * yet... implement the smallest safe operation consistent with [the current
 * domain model]"). HumanReviewItem already has exactly the fields this needs
 * (status, resolvedAt) — no new state machine, no new model.
 *
 * Phase 10.2 adds an OPTIONAL `resolution` classification ("approved" |
 * "spam") — still deliberately just a LABEL the human applies, never an
 * action: resolving still does NOT touch Email.state and does NOT trigger
 * any destination action. "Mark as spam" records that the operator judged
 * this email as spam; it does not move, forward, or delete anything. What
 * that operator actually did about it (replied manually, fixed a rule,
 * ignored it) still happens outside this system — the API must never
 * silently execute a destination action on the operator's behalf (§15's
 * explicit warning, still honored).
 *
 * Idempotent: resolving an already-resolved item is a no-op that returns the
 * existing row unchanged (including its original resolvedAt/resolution) —
 * calling this twice, or from a redelivered/duplicate request, never
 * produces a different result or an error. A resolution passed on a
 * second call to an already-resolved item is silently ignored, same as
 * every other field on this no-op path.
 */
export async function resolveReviewItem(
  tenantId: string,
  reviewItemId: string,
  resolution?: ReviewResolution,
  /** Phase 23: who decided — recorded in the audit trail (was always "system"). */
  actor = "system",
): Promise<HumanReviewItem | null> {
  if (resolution !== undefined && !REVIEW_RESOLUTIONS.includes(resolution)) {
    throw new ReviewResolutionError(`resolution must be one of: ${REVIEW_RESOLUTIONS.join(", ")}`);
  }

  const existing = await prisma.humanReviewItem.findFirst({ where: { id: reviewItemId, tenantId } });
  if (!existing) return null;
  // Already closed — by a person ("resolved") or by reprocessing ("superseded"):
  // a no-op, never a second resolution.
  if (existing.status !== "open") return existing;

  const now = new Date();
  const resolved = await prisma.$transaction(async (tx) => {
    const item = await tx.humanReviewItem.update({
      where: { id: reviewItemId },
      data: { status: "resolved", resolvedAt: now, resolution: resolution ?? null },
    });
    // The email itself leaves "awaiting review" once nothing about it is open
    // any more — otherwise the Emails list keeps showing it as waiting.
    const stillOpen = await tx.humanReviewItem.count({ where: { emailId: existing.emailId, status: "open" } });
    if (stillOpen === 0) {
      await tx.email.updateMany({
        where: { id: existing.emailId, state: { in: [EmailState.AWAITING_REVIEW, EmailState.ROUTING] } },
        data: { state: EmailState.REVIEWED, stateUpdatedAt: now },
      });
    }
    return item;
  });

  await recordAuditEvent(prisma, {
    tenantId,
    emailId: existing.emailId,
    eventType: AuditEventType.HUMAN_REVIEW_RESOLVED,
    actor,
    payload: { reviewItemId, resolution: resolution ?? null },
  });

  return resolved;
}
