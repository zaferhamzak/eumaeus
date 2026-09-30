"use client";

import { Badge } from "@/components/ui/Badge";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";
import { JsonViewer } from "@/components/ui/JsonViewer";
import type { AnalysisResultResponse, JevAnswer } from "@/types/api";

const QUESTION_LABELS: Record<string, MessageKey> = {
  is_spam: "emails.questionIsSpam",
  category: "emails.questionCategory",
  is_business_opportunity: "emails.questionIsBusinessOpportunity",
  is_collaboration: "emails.questionIsCollaboration",
  is_customer_related: "emails.questionIsCustomerRelated",
  requires_response: "emails.questionRequiresResponse",
  urgency: "emails.questionUrgency",
  human_review_required: "emails.questionHumanReviewRequired",
};

function isNoul(answer: JevAnswer): answer is { noul: number } {
  return "noul" in answer;
}
function isChoice(answer: JevAnswer): answer is { choice: string; probabilities?: Record<string, number>; confidence?: number } {
  return "choice" in answer;
}
function isScore(answer: JevAnswer): answer is { score: number; legend?: Record<string, string>; confidence?: number } {
  return "score" in answer;
}

function renderValue(answer: JevAnswer): string {
  if (isNoul(answer)) return `${Math.round(answer.noul * 100)}%`;
  if (isChoice(answer)) return answer.choice.replace(/_/g, " ");
  if (isScore(answer)) {
    const nearestLevel = answer.legend?.[String(Math.round(answer.score))];
    return nearestLevel ? `${answer.score.toFixed(2)} (${nearestLevel})` : answer.score.toFixed(2);
  }
  return "—";
}

function confidenceOf(answer: JevAnswer): number | undefined {
  if (isNoul(answer)) return undefined; // Noul answers have no separate confidence field — the probability itself IS the signal.
  return answer.confidence;
}

/**
 * §9: the human-readable PRIMARY view of a Jev analysis — never raw JSON as
 * the primary interface. A secondary JsonViewer (collapsed by default) is
 * offered for anyone who wants the exact backend payload.
 */
export function AnalysisView({ analysis }: { analysis: AnalysisResultResponse }) {
  const t = useT();
  if (analysis.status !== "ok" || !analysis.answers) {
    return (
      <div className="space-y-2">
        <Badge tone="danger">{t("emails.analysisFailed")}</Badge>
        <p className="text-sm text-foreground-muted">
          {analysis.errorClass ? `${analysis.errorClass}: ` : ""}
          {analysis.errorMessage ?? t("emails.noFurtherDetail")}
        </p>
      </div>
    );
  }

  const entries = Object.entries(analysis.answers);

  return (
    <div className="space-y-3">
      <div className="border border-border">
        {entries.map(([key, answer], i) => {
          const confidence = confidenceOf(answer);
          return (
            <div
              key={key}
              className={`flex items-center gap-3 px-3 py-2 ${i < entries.length - 1 ? "border-b border-border" : ""}`}
            >
              <p className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-medium text-foreground">{Object.prototype.hasOwnProperty.call(QUESTION_LABELS, key) ? t(QUESTION_LABELS[key]!) : key.replace(/_/g, " ")}</span>
                <span className="block truncate text-[10.5px] text-foreground-muted">{renderValue(answer)}</span>
              </p>
              {confidence !== undefined ? (
                <span className="shrink-0 font-mono text-[10px] text-foreground-subtle">{Math.round(confidence * 100)}%</span>
              ) : null}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-foreground-subtle">
        {t("emails.analysisModel", { model: analysis.jevModel, schema: analysis.schemaVersion })}
        {analysis.latencyMs !== null ? ` · ${analysis.latencyMs}ms` : ""}
        {analysis.inputTruncated ? ` · ${t("emails.inputTruncated")}` : ""}
      </p>
      <JsonViewer data={analysis.answers} label={t("emails.rawJevAnswers")} />
    </div>
  );
}
