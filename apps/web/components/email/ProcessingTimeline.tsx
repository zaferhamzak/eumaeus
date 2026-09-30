"use client";

import Link from "next/link";
import { useLocale, useT } from "@/lib/i18n/I18nProvider";
import { reviewReasonLabel } from "@/components/review/reviewReason";
import { Timeline, type TimelineStep } from "@/components/ui/Timeline";
import { StatusBadge, describeStatus } from "@/components/ui/StatusBadge";
import { formatDateTime } from "@/lib/format";
import type { EmailDetailResponse } from "@/types/api";

/**
 * §8: builds the visual timeline ENTIRELY from real fields already present on
 * EmailDetailResponse — never a fabricated `completed` backend state (§8's
 * explicit warning). The final step's label describes the actual terminal
 * signal that exists (an ActionExecution's real status, or a HumanReviewItem's
 * real status) rather than inventing a generic "Completed".
 */
export function ProcessingTimeline({ email }: { email: EmailDetailResponse }) {
  const t = useT();
  const locale = useLocale();
  const steps: TimelineStep[] = [];

  steps.push({
    key: "received",
    state: "done",
    title: t("emails.timelineReceived"),
    detail: formatDateTime(email.receivedAt),
  });

  if (email.analysis) {
    steps.push({
      key: "analyzed",
      state: email.analysis.status === "ok" ? "done" : "failed",
      title: email.analysis.status === "ok" ? t("emails.timelineAnalyzed") : t("emails.analysisFailed"),
      detail: (
        <span>
          Jev ({email.analysis.jevModel}){email.analysis.errorMessage ? ` — ${email.analysis.errorMessage}` : null}
        </span>
      ),
    });
  } else if (email.state === "analyzing") {
    steps.push({ key: "analyzed", state: "current", title: t("emails.timelineAnalyzing") });
  } else {
    steps.push({ key: "analyzed", state: "pending", title: t("emails.timelineAnalysis") });
  }

  if (email.routingDecision) {
    const rd = email.routingDecision;
    const matched = rd.status === "matched";
    steps.push({
      key: "routing",
      state: matched ? "done" : "failed",
      title: matched
        ? t("emails.timelineRuleMatched")
        : rd.status === "unmatched"
          ? t("emails.timelineNoRuleMatched")
          : rd.status === "human_review_forced"
            ? t("emails.timelineHumanReviewForced")
            : t("emails.timelineRoutingDecision"),
      detail: matched ? (
        <span>
          → <span className="font-medium text-foreground">{rd.destinationRef}</span>
        </span>
      ) : (
        <StatusBadge status={rd.status} />
      ),
    });
  } else {
    steps.push({ key: "routing", state: email.analysis ? "current" : "pending", title: t("emails.timelineRoutingDecision") });
  }

  if (email.actionExecutions.length > 0) {
    const latest = email.actionExecutions[0]!; // API returns newest first
    steps.push({
      key: "action",
      state: latest.status === "succeeded" ? "done" : latest.status === "pending" ? "current" : "failed",
      title: t("emails.timelineAction", { status: describeStatus(latest.status, t).label.toLocaleLowerCase(locale) }),
      detail: (
        <Link href={`/emails/${email.id}#actions`} className="text-accent hover:underline">
          {t("emails.timelineActionDetail", { channel: latest.channelType, attempt: latest.attemptNumber })}
        </Link>
      ),
    });
  }

  if (email.reviewItems.length > 0) {
    const latest = email.reviewItems[0]!;
    steps.push({
      key: "review",
      state: latest.status === "resolved" ? "done" : "current",
      title: latest.status === "resolved" ? t("emails.timelineReviewResolved") : t("emails.timelineReviewAwaiting"),
      detail: <span>{t("emails.timelineReviewReason", { reason: reviewReasonLabel(latest.reason, t) })}</span>,
    });
  }

  return <Timeline steps={steps} />;
}
