"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useReview, useResolveReview } from "@/hooks/useReviews";
import type { ReviewResolution } from "@/lib/api/review";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { StatusBadge, describeStatus } from "@/components/ui/StatusBadge";
import { Icon } from "@/components/ui/Icon";
import { SignalBadge } from "@/components/review/SignalBadge";
import { AnalysisView } from "@/components/email/AnalysisView";
import { RoutingDecisionView } from "@/components/email/RoutingDecisionView";
import { ActionExecutionCard } from "@/components/email/ActionExecutionCard";
import { AuditEventList } from "@/components/audit/AuditEventList";
import { formatDateTime } from "@/lib/format";
import { ApiRequestError } from "@/lib/api/client";
import type { ReviewDetailResponse } from "@/types/api";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";
import { reviewReasonLabel } from "@/components/review/reviewReason";
import { DecideSimilarCard } from "@/components/review/DecideSimilarCard";
import { ReviewTeamworkCard } from "@/components/review/ReviewTeamworkCard";
import { useHasPermission } from "@/hooks/useAuth";

const RESOLUTION_LABEL: Record<string, MessageKey> = { approved: "review.resolutionApproved", spam: "review.resolutionSpam" };

/**
 * Same icon-chip summary header pattern as Email/Rule/Destination. The
 * right-hand slot holds the real existing actions (Approve / Mark as spam —
 * both are still just the one real "resolve" mutation, with a real
 * classification label attached) or the real resolved timestamp + outcome —
 * never a fabricated metric, since a review item has no numeric stat
 * analogous to latency/priority/channel-count.
 */
function ReviewSummary({
  review,
  onResolve,
  resolving,
  canResolve,
}: {
  review: ReviewDetailResponse;
  onResolve: (resolution: ReviewResolution) => void;
  resolving: boolean;
  canResolve: boolean;
}) {
  const t = useT();
  const { tone } = describeStatus(review.status, t);
  const resolutionKey = review.resolution ? RESOLUTION_LABEL[review.resolution] : undefined;
  const icon = review.status === "resolved" ? "check" : "alert";

  return (
    <div className="grid grid-cols-[34px_1fr_auto] items-center gap-3 border border-border bg-surface-raised p-3 rounded-lg">
      <div
        className="grid h-[34px] w-[34px] place-items-center border"
        style={{
          color: `var(--status-${tone}-fg)`,
          background: `var(--status-${tone}-bg)`,
          borderColor: `color-mix(in srgb, var(--status-${tone}-fg) 35%, transparent)`,
        }}
      >
        <Icon name={icon} size={17} />
      </div>
      <div className="min-w-0">
        <span className="text-[8px] font-semibold tracking-wide text-foreground-subtle uppercase">{review.status === "open" ? t("review.awaitingHumanReview") : t("review.reviewResolved")}</span>
        <div className="flex items-center gap-2">
          <h1 className="truncate text-base font-semibold text-foreground capitalize">{reviewReasonLabel(review.reason, t)}</h1>
          <SignalBadge signal={review.signal} />
        </div>
        <p className="text-xs text-foreground-subtle">{t("review.createdAt", { time: formatDateTime(review.createdAt) })}</p>
      </div>
      {review.status === "open" ? (
        canResolve ? (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => onResolve("approved")} loading={resolving}>
              {t("review.approve")}
            </Button>
            <Button variant="danger" onClick={() => onResolve("spam")} loading={resolving}>
              {t("review.markAsSpam")}
            </Button>
          </div>
        ) : null
      ) : (
        <div className="text-right">
          <span className="block text-xs font-medium text-foreground">{review.resolution ? (resolutionKey ? t(resolutionKey) : review.resolution) : t("review.resolved")}</span>
          <span className="block text-[8px] text-foreground-subtle">{review.resolvedAt ? formatDateTime(review.resolvedAt) : ""}</span>
        </div>
      )}
    </div>
  );
}

/**
 * §15: everything a reviewer needs (email, analysis, routing, action state,
 * recent audit history) in ONE place — no five-tab hunt. Resolve is only
 * offered when status is still "open" (the backend's own idempotent resolve
 * makes a second click harmless regardless, but hiding it once resolved
 * avoids implying there's a meaningful further action to take).
 */
export default function ReviewDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const review = useReview(id);
  const resolve = useResolveReview(id);
  const [pendingResolution, setPendingResolution] = useState<ReviewResolution | null>(null);
  const t = useT();
  const canResolve = useHasPermission("reviews:resolve") === true;

  if (review.isPending) return <LoadingState label={t("review.loadingItem")} />;
  if (review.isError) return <ErrorState error={review.error} onRetry={() => review.refetch()} />;

  const r = review.data;

  return (
    <div className="space-y-4">
      <Link href="/review" className="text-xs text-foreground-muted hover:text-accent hover:underline">
        {t("review.backToList")}
      </Link>

      <ReviewSummary review={r} onResolve={setPendingResolution} resolving={resolve.isPending} canResolve={canResolve} />

      {resolve.isError ? (
        <p className="rounded-md bg-status-danger-bg px-3 py-2 text-sm text-status-danger-fg" role="alert">
          {resolve.error instanceof ApiRequestError ? resolve.error.message : t("review.resolveFailed")}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card>
            <CardHeader
              title={t("review.cardEmail")}
              action={
                <Link href={`/emails/${r.email.id}`} className="text-xs text-accent hover:underline">
                  {t("review.openFullDetail")}
                </Link>
              }
            />
            <CardBody className="space-y-1.5">
              <p className="text-sm font-medium text-foreground">{r.email.subject || t("review.noSubject")}</p>
              <p className="text-xs text-foreground-muted">{t("review.from", { address: r.email.fromAddress })}</p>
              <StatusBadge status={r.email.state} dense />
            </CardBody>
          </Card>

          <DecideSimilarCard key={r.id} reviewId={r.id} currentOpen={r.status === "open"} canResolve={canResolve} />

          <ReviewTeamworkCard review={r} canResolve={canResolve} />

          {r.analysis ? (
            <Card>
              <CardHeader title={t("review.cardAnalysis")} />
              <CardBody>
                <AnalysisView analysis={r.analysis} />
              </CardBody>
            </Card>
          ) : null}

          {r.actionExecutions.length > 0 ? (
            <Card>
              <CardHeader title={t("review.cardActionExecutions")} />
              <CardBody className="space-y-3">
                {r.actionExecutions.map((exec) => (
                  <ActionExecutionCard key={exec.id} execution={exec} siblings={r.actionExecutions} />
                ))}
              </CardBody>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          {r.routingDecision ? (
            <Card>
              <CardHeader title={t("review.cardRouting")} />
              <CardBody>
                <RoutingDecisionView decision={r.routingDecision} />
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader title={t("review.cardRecentAudit")} />
            <CardBody>
              <AuditEventList events={r.recentAuditEvents} emptyMessage={t("review.auditEmpty")} viewAllHref={`/audit?emailId=${r.email.id}`} />
            </CardBody>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={pendingResolution !== null}
        title={pendingResolution === "spam" ? t("review.spamConfirmTitle") : t("review.approveConfirmTitle")}
        description={t("review.resolveConfirmDescription")}
        confirmLabel={pendingResolution === "spam" ? t("review.markAsSpam") : t("review.approve")}
        confirmVariant={pendingResolution === "spam" ? "danger" : "primary"}
        loading={resolve.isPending}
        onConfirm={() => pendingResolution && resolve.mutate(pendingResolution, { onSettled: () => setPendingResolution(null) })}
        onCancel={() => setPendingResolution(null)}
      />
    </div>
  );
}
