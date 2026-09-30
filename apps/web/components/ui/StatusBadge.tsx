"use client";

import { Badge, type BadgeTone } from "./Badge";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";
import type { Translate } from "@/lib/i18n/translate";

/**
 * The ONE place a backend state STRING is mapped to a label + color (§6:
 * "do not collapse all of these into a generic green/red badge" — every
 * distinct state gets its own label, several intentionally share a tone
 * where that's semantically honest, e.g. every "this needs a human to look
 * at it" state is `warning`, every "this is a genuine terminal failure"
 * state is `danger`, but no two DIFFERENT states are ever merged into one
 * displayed label).
 *
 * Covers every state vocabulary used across the app: Email.state,
 * RoutingDecision.status, ActionExecution.status, HumanReviewItem.status,
 * MailboxConnection.status/syncStatus. An unrecognized string (a future
 * backend state this UI hasn't been updated for yet) is shown verbatim with
 * a neutral tone rather than crashing or silently hiding it.
 */
const STATE_MAP: Record<string, { label: MessageKey; tone: BadgeTone }> = {
  // Email.state
  received: { label: "common.statusReceived", tone: "neutral" },
  analyzing: { label: "common.statusAnalyzing", tone: "info" },
  analyzed: { label: "common.statusAnalyzed", tone: "info" },
  routing: { label: "common.statusRouting", tone: "info" },
  awaiting_review: { label: "common.statusAwaitingReview", tone: "warning" },
  reviewed: { label: "common.statusReviewed", tone: "success" },

  // RoutingDecision.status
  matched: { label: "common.statusMatched", tone: "success" },
  unmatched: { label: "common.statusUnmatched", tone: "warning" },
  human_review_forced: { label: "common.statusHumanReviewForced", tone: "warning" },
  sender_allowed: { label: "common.statusSenderAllowed", tone: "success" },
  reauth_required: { label: "common.statusReauthRequired", tone: "danger" },
  invalid_config: { label: "common.statusInvalidConfig", tone: "danger" },
  missing_analysis: { label: "common.statusMissingAnalysis", tone: "danger" },

  // ActionExecution.status
  pending: { label: "common.statusPending", tone: "info" },
  succeeded: { label: "common.statusSucceeded", tone: "success" },
  ambiguous: { label: "common.statusAmbiguous", tone: "warning" },

  // HumanReviewItem.status
  open: { label: "common.statusOpen", tone: "warning" },
  resolved: { label: "common.statusResolved", tone: "success" },
  // Human Review item closed because the email was reprocessed — not a person's decision.
  superseded: { label: "common.statusSuperseded", tone: "neutral" },

  // MailboxConnection.status / syncStatus
  active: { label: "common.statusActive", tone: "success" },
  disabled: { label: "common.statusDisabled", tone: "neutral" },
  idle: { label: "common.statusIdle", tone: "neutral" },
  syncing: { label: "common.statusSyncing", tone: "info" },

  // Shared across several vocabularies — all genuinely mean "terminal failure".
  failed: { label: "common.statusFailed", tone: "danger" },
};

/** Shared with any component that needs the label/tone without rendering a Badge itself (e.g. a decision-block headline) — never re-derive this mapping elsewhere. Pass the component's `useT()`. */
export function describeStatus(status: string, t: Translate): { label: string; tone: BadgeTone } {
  const entry = STATE_MAP[status];
  return entry ? { label: t(entry.label), tone: entry.tone } : { label: status, tone: "neutral" };
}

export function StatusBadge({ status, dense = false }: { status: string; dense?: boolean }) {
  const t = useT();
  const { label, tone } = describeStatus(status, t);
  return (
    <Badge tone={tone} variant={dense ? "dot" : "pill"}>
      {label}
    </Badge>
  );
}
