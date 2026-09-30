"use client";

import { useState } from "react";
import { useHasPermission } from "@/hooks/useAuth";
import { useReprocessEmail, useReprocessPreview } from "@/hooks/useOps";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ApiRequestError } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import type { RoutingDecisionResponse } from "@/types/api";
import { useT } from "@/lib/i18n/I18nProvider";
import type { Translate } from "@/lib/i18n/translate";
import { Checkbox } from "@/components/ui/Checkbox";

function destinationLabel(
  ref: string | null | undefined,
  t: Translate,
): string {
  if (!ref || ref === "human_review") return t("emails.destHumanReview");
  if (ref === "left_alone") return t("emails.destLeftAlone");
  return `"${ref}"`;
}

/**
 * Phase 18: run this email through today's rules again. "Check" is a
 * read-only preview; "Reprocess" replaces the decision and runs its actions.
 * Earlier decisions stay listed below — nothing is overwritten. Phase 22:
 * "Ask Jev again" re-runs the Jev analysis first (otherwise the stored one is
 * reused).
 */
export function ReprocessPanel({
  emailId,
  previous,
}: {
  emailId: string;
  previous: RoutingDecisionResponse[];
}) {
  const t = useT();
  const canReprocess = useHasPermission("emails:reprocess") === true;
  const preview = useReprocessPreview(emailId);
  const reprocess = useReprocessEmail(emailId);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reanalyze, setReanalyze] = useState(false);
  const sample = preview.data?.samples[0];

  return (
    <div className="space-y-3 border-t border-border pt-3">
      {canReprocess ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              loading={preview.isPending}
              onClick={() => preview.mutate()}
            >
              {t("emails.checkWithCurrentRules")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => setConfirmOpen(true)}
              loading={reprocess.isPending}
            >
              {t("emails.reprocess")}
            </Button>
          </div>
          <label className="flex items-start gap-2 text-xs">
            <Checkbox
              className="mt-0.5"
              checked={reanalyze}
              onChange={(e) => setReanalyze(e.target.checked)}
            />
            <span>
              <span className="font-medium text-foreground">
                {t("emails.reanalyzeLabel")}
              </span>
              <span className="block text-foreground-subtle">
                {t("emails.reanalyzeHelp")}
              </span>
            </span>
          </label>
          {sample ? (
            <p className="text-xs text-foreground-muted" role="status">
              {sample.changed
                ? t("emails.previewChanged", {
                    after: destinationLabel(sample.after.destinationRef, t),
                    before: destinationLabel(sample.before?.destinationRef, t),
                  })
                : t("emails.previewSame", {
                    after: destinationLabel(sample.after.destinationRef, t),
                  })}
            </p>
          ) : null}
          {reprocess.data ? (
            <p className="text-xs text-status-success-fg" role="status">
              {t("emails.reprocessed", {
                destination: destinationLabel(
                  reprocess.data.decision.status === "matched"
                    ? reprocess.data.decision.destinationRef
                    : reprocess.data.decision.status === "sender_allowed"
                      ? "left_alone"
                      : "human_review",
                  t,
                ),
              })}
            </p>
          ) : null}
          {reprocess.isError ? (
            <p className="text-xs text-status-danger-fg" role="alert">
              {reprocess.error instanceof ApiRequestError
                ? reprocess.error.message
                : t("emails.reprocessFailed")}
            </p>
          ) : null}
        </div>
      ) : null}

      {previous.length > 0 ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-foreground-subtle">
            {t("emails.earlierDecisions", { count: previous.length })}
          </summary>
          <ul className="mt-2 space-y-1.5">
            {previous.map((d) => (
              <li
                key={d.id}
                className="flex flex-wrap items-center gap-2 text-foreground-muted"
              >
                <StatusBadge status={d.status} dense />
                <span>
                  {d.status === "matched"
                    ? destinationLabel(d.destinationRef, t)
                    : ""}
                </span>
                <span className="text-foreground-subtle">
                  ·{" "}
                  {t("emails.replacedAt", {
                    time: d.supersededAt ? formatDateTime(d.supersededAt) : "",
                  })}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        title={t("emails.reprocessConfirmTitle")}
        description={
          reanalyze
            ? `${t("emails.reprocessConfirmDescription")} ${t("emails.reprocessConfirmReanalyze")}`
            : t("emails.reprocessConfirmDescription")
        }
        confirmLabel={t("emails.reprocess")}
        confirmVariant="primary"
        loading={reprocess.isPending}
        onConfirm={() =>
          reprocess.mutate(
            { reanalyze },
            { onSettled: () => setConfirmOpen(false) },
          )
        }
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
