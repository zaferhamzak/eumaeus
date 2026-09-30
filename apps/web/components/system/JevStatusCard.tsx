"use client";

import { useState } from "react";
import { useJevStatus, useRetryJev } from "@/hooks/useOps";
import { useHasPermission } from "@/hooks/useAuth";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/LoadingState";
import { formatRelativeTime } from "@/lib/format";
import { useT } from "@/lib/i18n/I18nProvider";

/**
 * 1.2 (G): is Jev working for this organization? When it last answered, the
 * error it is giving now (a refused key or plan says so plainly), emails
 * still waiting and emails it couldn't analyze — with "ask Jev again" for
 * those (billed, so confirmed first). `onlyWhenTroubled`: the dashboard shows
 * it only when something needs a look; the System page always.
 */
export function JevStatusCard({ onlyWhenTroubled = false }: { onlyWhenTroubled?: boolean }) {
  const t = useT();
  const canSee = useHasPermission("stats:read") === true;
  const canRetry = useHasPermission("emails:reprocess") === true;
  const status = useJevStatus(canSee);
  const retry = useRetryJev();
  const [confirming, setConfirming] = useState(false);
  if (!canSee) return null;

  const s = status.data;
  const troubled = Boolean(s && (s.currentError || s.failed > 0 || s.waiting > 0));
  if (onlyWhenTroubled && !troubled) return null;

  const retried = retry.data?.results;
  const retriedOk = retried?.filter((r) => r.status === "reprocessed").length ?? 0;

  return (
    <Card className={troubled ? "border-t-[3px] border-t-accent-bright" : undefined}>
      <CardHeader
        title={t("system.jevTitle")}
        action={
          s ? (
            s.accessDenied ? (
              <Badge tone="danger">{t("system.jevRefused")}</Badge>
            ) : s.currentError ? (
              <Badge tone="warning">{t("system.jevFailing")}</Badge>
            ) : s.lastSuccessAt ? (
              <Badge tone="success">{t("system.jevOk")}</Badge>
            ) : (
              <Badge tone="neutral">{t("system.jevNoData")}</Badge>
            )
          ) : null
        }
      />
      <CardBody className="space-y-3 text-sm">
        {status.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : status.isError ? (
          <ErrorState error={status.error} onRetry={() => status.refetch()} />
        ) : s ? (
          <>
            {s.currentError ? (
              <div className="rounded-md border border-status-danger-fg/30 bg-status-danger-bg/60 px-3 py-2">
                <p className="font-medium text-status-danger-fg">{s.accessDenied ? t("system.jevRefusedExplain", { status: s.currentError.httpStatus ?? "" }) : t("system.jevErrorExplain")}</p>
                {s.currentError.message ? <p className="mt-0.5 break-words text-xs text-foreground-muted">“{s.currentError.message}”</p> : null}
              </div>
            ) : null}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
              <div>
                <dt className="text-foreground-subtle">{t("system.jevLastSuccess")}</dt>
                <dd className="font-medium text-foreground">{s.lastSuccessAt ? formatRelativeTime(s.lastSuccessAt) : "—"}</dd>
              </div>
              <div>
                <dt className="text-foreground-subtle">{t("system.jevWaiting")}</dt>
                <dd className={s.waiting > 0 ? "font-medium text-status-warning-fg" : "font-medium text-foreground"}>{s.waiting}</dd>
              </div>
              <div>
                <dt className="text-foreground-subtle">{t("system.jevFailed")}</dt>
                <dd className={s.failed > 0 ? "font-medium text-status-danger-fg" : "font-medium text-foreground"}>{s.failed}</dd>
              </div>
              <div>
                <dt className="text-foreground-subtle">{t("system.jevWeek")}</dt>
                <dd className="font-medium text-foreground">{t("system.jevWeekValue", { ok: s.last7Days.ok, error: s.last7Days.error })}</dd>
              </div>
            </dl>
            {s.failed > 0 && canRetry ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" loading={retry.isPending} onClick={() => setConfirming(true)}>
                  {t("system.jevRetry", { count: s.failedEmailIds.length })}
                </Button>
                {retried ? <span role="status" className="text-xs text-foreground-muted">{t("system.jevRetried", { ok: retriedOk, total: retried.length })}</span> : null}
                {s.accessDenied ? <span className="text-xs text-foreground-subtle">{t("system.jevRetryAfterFix")}</span> : null}
              </div>
            ) : null}
          </>
        ) : null}
      </CardBody>
      <ConfirmDialog
        open={confirming}
        title={t("system.jevRetryConfirmTitle")}
        description={t("system.jevRetryConfirmBody", { count: s?.failedEmailIds.length ?? 0 })}
        confirmLabel={t("system.jevRetryConfirm")}
        loading={retry.isPending}
        onConfirm={() => {
          if (s) retry.mutate(s.failedEmailIds, { onSettled: () => setConfirming(false) });
        }}
        onCancel={() => setConfirming(false)}
      />
    </Card>
  );
}
