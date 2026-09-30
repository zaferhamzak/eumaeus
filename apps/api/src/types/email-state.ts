/**
 * Email processing state machine.
 *
 * This is the SAME state machine defined in implementation-plan.md §H, not a new
 * one — each phase has only made previously-designed-but-unreachable states
 * reachable:
 *
 *   received        -> ingestion succeeded; nothing has processed it further yet
 *   analyzing       -> the process-email job is currently calling Jev
 *   analyzed        -> Jev analysis succeeded and was persisted as an AnalysisResult
 *                       — "we now have a structured decision," NOT "an action was
 *                       taken."
 *   routing         -> the Rule Engine matched a rule and produced a
 *                       RoutingDecision (a destination is known) — still NOT "an
 *                       action was taken." Sending/forwarding/archiving is the
 *                       future destinations/action phase's job, not the Rule
 *                       Engine's (implementation-plan.md §L).
 *   failed          -> processing (ingestion OR analysis) exhausted its retries
 *   awaiting_review -> escalated to a HumanReviewItem — a processing failure, no
 *                       rule matched, or Jev's own human_review_required signal
 *                       overrode normal routing
 *
 * The remaining states from the full state machine (executing_actions, completed)
 * are intentionally not exposed here — using them now would claim an action was
 * taken, which nothing through Phase 4 ever does. They arrive with the phase that
 * implements real destination execution.
 */
export const EmailState = {
  RECEIVED: "received",
  ANALYZING: "analyzing",
  ANALYZED: "analyzed",
  ROUTING: "routing",
  FAILED: "failed",
  AWAITING_REVIEW: "awaiting_review",
  // A person resolved the email's last open Human Review item.
  REVIEWED: "reviewed",
} as const;

export type EmailStateValue = (typeof EmailState)[keyof typeof EmailState];
