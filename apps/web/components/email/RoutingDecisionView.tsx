"use client";

import { StatusBadge } from "@/components/ui/StatusBadge";
import { useT } from "@/lib/i18n/I18nProvider";
import { formatDateTime } from "@/lib/format";
import type { RoutingDecisionResponse } from "@/types/api";

/** §11: routing decision detail, including the explicit "no rule matched → Human Review" and "human_review_required override" cases spelled out in plain language rather than left as a bare status code. */
export function RoutingDecisionView({ decision }: { decision: RoutingDecisionResponse }) {
  const t = useT();
  const code = (c: string) => <code className="font-mono">{c}</code>;
  return (
    <dl className="space-y-2.5 text-sm">
      <div className="flex items-center justify-between">
        <dt className="text-xs text-foreground-muted">{t("emails.decision")}</dt>
        <dd>
          <StatusBadge status={decision.status} dense />
        </dd>
      </div>

      {decision.status === "unmatched" ? (
        <p className="border-l-2 border-status-warning-fg bg-status-warning-bg/40 px-2.5 py-2 text-xs text-status-warning-fg">
          {t("emails.decisionUnmatchedNote")}
        </p>
      ) : null}
      {decision.status === "human_review_forced" ? (
        <p className="border-l-2 border-status-warning-fg bg-status-warning-bg/40 px-2.5 py-2 text-xs text-status-warning-fg">
          {t.rich("emails.decisionForcedNote", { code })}
        </p>
      ) : null}
      {decision.status === "sender_allowed" ? (
        <p className="border-l-2 border-status-success-fg bg-status-success-bg/40 px-2.5 py-2 text-xs text-status-success-fg">
          {t.rich("emails.decisionAllowedNote", { code }, { pattern: decision.senderListPattern ?? "" })}
        </p>
      ) : null}
      {decision.status === "matched" && decision.senderListPattern ? (
        <p className="border-l-2 border-status-warning-fg bg-status-warning-bg/40 px-2.5 py-2 text-xs text-status-warning-fg">
          {t.rich("emails.decisionBlockedNote", { code }, { pattern: decision.senderListPattern ?? "" })}
        </p>
      ) : null}
      {decision.status === "missing_analysis" ? (
        <p className="border-l-2 border-status-danger-fg bg-status-danger-bg/40 px-2.5 py-2 text-xs text-status-danger-fg">
          {t("emails.decisionMissingAnalysisNote")}
        </p>
      ) : null}

      {decision.destinationRef ? (
        <div className="flex items-center justify-between">
          <dt className="text-xs text-foreground-muted">{t("emails.destination")}</dt>
          <dd className="text-xs font-medium text-foreground">{decision.destinationRef}</dd>
        </div>
      ) : null}
      {decision.matchedRuleId ? (
        <div className="flex items-center justify-between">
          <dt className="text-xs text-foreground-muted">{t("emails.matchedRule")}</dt>
          <dd className="font-mono text-[10.5px] text-foreground">
            {decision.matchedRuleId} (v{decision.matchedRuleVersion})
          </dd>
        </div>
      ) : null}
      {decision.ruleGraphId ? (
        <>
          <div className="flex items-center justify-between">
            <dt className="text-xs text-foreground-muted">{t("emails.decidedByRuleGraph")}</dt>
            <dd className="font-mono text-[10.5px] text-foreground">
              {decision.ruleGraphId} (v{decision.ruleGraphVersion})
            </dd>
          </div>
          {decision.graphPath && decision.graphPath.length > 0 ? (
            <div>
              <dt className="mb-1 text-xs text-foreground-muted">{t("emails.pathTaken")}</dt>
              <dd className="flex flex-wrap items-center gap-1 font-mono text-[10.5px]">
                {decision.graphPath.map((step, i) => (
                  <span key={`${step.nodeKey}-${i}`} className="flex items-center gap-1">
                    {i > 0 ? <span className="text-foreground-subtle">→</span> : null}
                    <span className={step.matched ? "text-status-success-fg" : "text-foreground-muted"}>
                      {step.nodeKey} {step.matched ? "✓" : "✗"}
                    </span>
                  </span>
                ))}
                {decision.destinationRef ? (
                  <>
                    <span className="text-foreground-subtle">→</span>
                    <span className="font-medium text-foreground">{decision.destinationRef}</span>
                  </>
                ) : null}
              </dd>
            </div>
          ) : null}
        </>
      ) : null}
      <div className="flex items-center justify-between">
        <dt className="text-xs text-foreground-muted">{t("emails.decided")}</dt>
        <dd className="text-xs text-foreground-muted">{formatDateTime(decision.createdAt)}</dd>
      </div>
    </dl>
  );
}
