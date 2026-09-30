import type { MessageKey } from "@/lib/i18n/messages";
import type { Translate } from "@/lib/i18n/translate";

/** HumanReviewItem.reason codes the UI knows; an unknown code is shown with underscores turned into spaces. */
export const REVIEW_REASON_LABEL: Record<string, MessageKey> = {
  failed: "review.reasonFailed",
  unmatched: "review.reasonUnmatched",
  ambiguous: "review.reasonAmbiguous",
  low_confidence: "review.reasonLowConfidence",
  manual_review_requested: "review.reasonManualReviewRequested",
  execution_failed: "review.reasonExecutionFailed",
  execution_ambiguous: "review.reasonExecutionAmbiguous",
  human_review_required: "review.reasonHumanReviewRequired",
};

export function reviewReasonLabel(reason: string, t: Translate): string {
  const key = REVIEW_REASON_LABEL[reason];
  return key ? t(key) : reason.replace(/_/g, " ");
}
