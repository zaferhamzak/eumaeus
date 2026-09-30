import { prisma } from "../../db/client.js";
import { recordAuditEvent, AuditEventType } from "../audit/record.js";
import { EmailState } from "../../types/email-state.js";
import { metrics } from "../../metrics/metrics.js";
import { MetricName } from "../../metrics/names.js";

export type ReviewReason =
  | "failed"
  | "unmatched"
  | "ambiguous"
  | "low_confidence"
  // --- Phase 5A: destination execution lifecycle ---
  | "manual_review_requested" // a rule's destinationRef was the reserved "human_review" value — an operator's deliberate choice, not a safety-net fallback
  | "execution_failed" // an ActionExecution exhausted retries (or hit a non-retryable error) without succeeding
  | "execution_ambiguous"; // an ActionExecution's external outcome could not be determined (e.g. a timed-out/interrupted attempt)

/**
 * The mandatory safety net (implementation-plan.md §M / principle #12): when
 * processing cannot safely continue, an email must never be left stuck or
 * silently dropped — it is explicitly moved to `awaiting_review` and a
 * HumanReviewItem is created so a person can resolve it.
 *
 * This mirrors the `... -> awaiting_review(reason=...)` transition from the full
 * state machine (implementation-plan.md §H) exactly; it is not a new state or a
 * new pattern invented per-phase — Phase 1 introduced it for processing failures
 * (reason="failed", the default, preserving that exact behavior/audit trail
 * unchanged), Phase 4 reuses it as-is for the Rule Engine's "unmatched"/
 * "ambiguous" outcomes rather than inventing a parallel mechanism.
 *
 * Idempotent: if an open HumanReviewItem already exists for this email (e.g. this
 * is a redelivered/duplicate escalation), this is a no-op rather than a second
 * review item.
 */
export async function escalateToHumanReview(
  tenantId: string,
  emailId: string,
  details: { errorMessage: string; attemptsMade: number; reason?: ReviewReason },
): Promise<void> {
  const reason: ReviewReason = details.reason ?? "failed";

  const created = await prisma.$transaction(async (tx) => {
    const existingOpenItem = await tx.humanReviewItem.findFirst({
      where: { emailId, status: "open" },
    });
    if (existingOpenItem) {
      return false;
    }

    // Only a genuine processing FAILURE gets this specific event — a rule
    // engine outcome like "no rule matched" is not a failure, and labeling it
    // one in the audit trail would be misleading. Unchanged for reason="failed"
    // (the only case Phase 1-3 ever used), so their audit-sequence assertions
    // still hold exactly.
    if (reason === "failed") {
      await recordAuditEvent(tx, {
        tenantId,
        emailId,
        eventType: AuditEventType.EMAIL_PROCESSING_FAILED,
        actor: "system",
        payload: { errorMessage: details.errorMessage, attemptsMade: details.attemptsMade },
      });
    }

    await tx.email.update({
      where: { id: emailId },
      data: { state: EmailState.AWAITING_REVIEW, stateUpdatedAt: new Date() },
    });

    await tx.humanReviewItem.create({
      data: { tenantId, emailId, reason, status: "open" },
    });

    await recordAuditEvent(tx, {
      tenantId,
      emailId,
      eventType: AuditEventType.EMAIL_ROUTED_TO_REVIEW,
      actor: "system",
      payload: { reason, errorMessage: reason === "failed" ? undefined : details.errorMessage },
    });
    return true;
  });
  // Counts actual NEW escalations only — a redelivered/duplicate call that hit
  // the idempotent no-op above must not inflate this metric.
  if (created) metrics.increment(MetricName.HUMAN_REVIEW_ESCALATED, { reason });
}
