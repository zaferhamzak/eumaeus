"use client";

import Link from "next/link";
import { AlertsCard } from "@/components/overview/AlertsCard";
import { JevStatusCard } from "@/components/system/JevStatusCard";
import { DailyMailChart } from "@/components/overview/DailyMailChart";
import { ReviewQueueCard } from "@/components/overview/ReviewQueueCard";
import { MailboxHealthCard } from "@/components/overview/MailboxHealthCard";
import { useStats } from "@/hooks/useStats";
import { useReport } from "@/hooks/useOps";
import { useAuditList } from "@/hooks/useAudit";
import { useReviewsList } from "@/hooks/useReviews";
import { useHasPermission } from "@/hooks/useAuth";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/LoadingState";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatRelativeTime } from "@/lib/format";
import { describeAuditEvent } from "@/lib/auditEventCopy";
import { useT } from "@/lib/i18n/I18nProvider";
import { cn } from "@/lib/cn";

/**
 * 0.31 dashboard. Summary before detail: what needs a person (alerts, the
 * review queue, failed actions) is at the top and marked in Claude orange;
 * the week's traffic, the pipeline, mailbox health and recent activity
 * follow. Every figure is real data from the stats, reports, reviews and
 * mailbox-health endpoints — nothing is decorative.
 */
function SummaryCard({
  label,
  value,
  note,
  href,
  attention = false,
}: {
  label: string;
  value: string | number | undefined;
  note?: string;
  href?: string;
  attention?: boolean;
}) {
  const body = (
    <div
      className={cn(
        "h-full min-h-[112px] rounded-lg border border-border bg-surface-raised px-4 py-3.5 transition-colors",
        href && "group-hover:border-border-strong",
        attention && "border-t-[3px] border-t-accent-bright pt-3",
      )}
    >
      <p className="text-xs font-medium text-foreground-muted">{label}</p>
      {value === undefined ? (
        <Skeleton className="mt-2 h-7 w-14" />
      ) : (
        <p className="mt-1 text-[26px] leading-tight font-bold tabular-nums text-foreground">{value}</p>
      )}
      {note ? <p className="mt-0.5 text-xs text-foreground-subtle">{note}</p> : null}
    </div>
  );
  return href ? (
    <Link href={href} className="group block h-full">
      {body}
    </Link>
  ) : (
    body
  );
}

function PipelineStep({ label, value, href }: { label: string; value: number | undefined; href: string }) {
  return (
    <Link href={href} className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-3 py-2 hover:bg-surface">
      <span className="truncate text-[11px] text-foreground-muted">{label}</span>
      <span className="text-base font-semibold tabular-nums text-foreground">{value ?? "—"}</span>
    </Link>
  );
}

export default function OverviewPage() {
  const t = useT();
  const stats = useStats();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const report = useReport({ days: 7, tz });
  const activity = useAuditList({});
  const mine = useReviewsList({ status: "open", assignedTo: "me" });
  const canWriteRules = useHasPermission("rules:write") === true;

  const s = stats.data;
  const r = report.data;
  const today = r?.daily.at(-1);
  const yesterday = r?.daily.at(-2);
  const mineCount = mine.data ? (mine.data.pages[0]?.data.length ?? 0) : undefined;
  const mineMore = Boolean(mine.data?.pages[0]?.pagination.hasMore);
  const auth = r?.senderAuth;
  const verifiedPct = auth && auth.checked > 0 ? Math.round((auth.verified / auth.checked) * 100) : null;
  const failed = s ? (s.actions.failed ?? 0) + (s.actions.ambiguous ?? 0) : undefined;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">{t("overview.title")}</h1>
          <p className="text-sm text-foreground-muted">{r ? t("overview.periodNote", { tz: r.timeZone }) : t("overview.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <Link href="/reports">
            <Button variant="secondary">{t("overview.openReports")}</Button>
          </Link>
          {canWriteRules ? (
            <Link href="/rules/new">
              <Button variant="primary">{t("overview.newRule")}</Button>
            </Link>
          ) : null}
        </div>
      </header>

      <AlertsCard />
      <JevStatusCard onlyWhenTroubled />

      {stats.isError ? <ErrorState error={stats.error} onRetry={() => stats.refetch()} /> : null}

      <section aria-label={t("overview.summaryAria")} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryCard
          label={t("overview.cardToday")}
          value={today?.emails}
          note={yesterday ? t("overview.cardYesterday", { count: yesterday.emails }) : undefined}
          href="/emails"
        />
        <SummaryCard
          label={t("overview.cardWaiting")}
          value={s?.review.open}
          note={mineCount !== undefined && mineCount > 0 ? t("overview.cardAssignedToMe", { count: mineMore ? `${mineCount}+` : mineCount }) : t("overview.cardWaitingNote")}
          href="/review?status=open"
          attention={(s?.review.open ?? 0) > 0}
        />
        <SummaryCard
          label={t("overview.cardFailed")}
          value={failed}
          note={s && (s.actions.ambiguous ?? 0) > 0 ? t("overview.cardAmbiguous", { count: s.actions.ambiguous ?? 0 }) : t("overview.cardFailedNote")}
          href="/emails"
          attention={(failed ?? 0) > 0}
        />
        <SummaryCard
          label={t("overview.cardVerified")}
          value={r ? (verifiedPct === null ? "—" : `%${verifiedPct}`) : undefined}
          note={verifiedPct === null ? t("overview.cardVerifiedNone") : t("overview.cardVerifiedNote", { checked: auth?.checked ?? 0 })}
        />
      </section>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <DailyMailChart report={report} />
        <ReviewQueueCard />
      </section>

      <Card>
        <CardHeader title={t("overview.pipelineTitle")} />
        <div className="flex flex-wrap gap-1 p-2">
          <PipelineStep label={t("overview.statReceived")} value={s?.emails.received} href="/emails?status=received" />
          <PipelineStep label={t("overview.statAnalyzed")} value={s?.emails.analyzed} href="/emails?status=analyzed" />
          <PipelineStep label={t("overview.statRouted")} value={s?.emails.routing} href="/emails?status=routing" />
          <PipelineStep label={t("overview.statAwaitingReview")} value={s?.emails.awaiting_review} href="/emails?status=awaiting_review" />
          <PipelineStep label={t("overview.statReviewed")} value={s?.emails.reviewed} href="/emails?status=reviewed" />
          <PipelineStep label={t("overview.actionsPending")} value={s?.actions.pending} href="/emails" />
        </div>
      </Card>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <MailboxHealthCard />
        <Card className="flex h-full min-h-[260px] flex-col">
          <CardHeader
            title={t("overview.recentActivity")}
            action={
              <Link href="/audit" className="text-xs text-accent hover:underline">
                {t("overview.viewAll")}
              </Link>
            }
          />
          {activity.isPending ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-7 w-full" />
              ))}
            </div>
          ) : activity.isError ? (
            <ErrorState error={activity.error} onRetry={() => activity.refetch()} />
          ) : activity.data.pages[0]?.data.length === 0 ? (
            <div className="flex flex-1 items-center justify-center"><EmptyState title={t("overview.activityEmptyTitle")} description={t("overview.activityEmptyDescription")} /></div>
          ) : (
            <ul className="divide-y divide-border">
              {activity.data.pages
                .flatMap((page) => page.data)
                .slice(0, 6)
                .map((event) => {
                  const { label, tone } = describeAuditEvent(event.eventType, t);
                  return (
                    <li key={event.id} className="flex items-center gap-3 px-4 py-2">
                      <span className="w-20 shrink-0 text-xs text-foreground-subtle">{formatRelativeTime(event.createdAt)}</span>
                      <Badge tone={tone}>{label}</Badge>
                      {event.emailId ? (
                        <Link href={`/emails/${event.emailId}`} className="ml-auto shrink-0 text-xs text-foreground-muted hover:text-accent hover:underline">
                          {t("overview.viewEmail")}
                        </Link>
                      ) : null}
                    </li>
                  );
                })}
            </ul>
          )}
        </Card>
      </section>
    </div>
  );
}
