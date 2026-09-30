"use client";

import { useLiveness, useReadiness, useMetrics } from "@/hooks/useHealth";
import { useStats } from "@/hooks/useStats";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { JsonViewer } from "@/components/ui/JsonViewer";
import { useT } from "@/lib/i18n/I18nProvider";
import { SyncHealthCards } from "@/components/system/SyncHealthCards";
import { JevStatusCard } from "@/components/system/JevStatusCard";

/** §22: real operational signals only — health/readiness/metrics/backlog, never a fabricated "infrastructure monitoring platform." */
export default function SystemPage() {
  const t = useT();
  const liveness = useLiveness();
  const readiness = useReadiness();
  const metrics = useMetrics();
  const stats = useStats();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-lg font-semibold text-foreground">{t("system.title")}</h1>
        <p className="text-sm text-foreground-muted">{t("system.subtitle")}</p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader title={t("system.liveness")} />
          <CardBody>
            {liveness.isPending ? <LoadingState /> : liveness.isError ? <ErrorState error={liveness.error} /> : <Badge tone="success">{t("system.alive")}</Badge>}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={t("system.readiness")} />
          <CardBody className="space-y-2">
            {readiness.isPending ? (
              <LoadingState />
            ) : readiness.isError ? (
              <ErrorState error={readiness.error} />
            ) : (
              <>
                <Badge tone={readiness.data.status === "ok" ? "success" : "danger"}>{readiness.data.status === "ok" ? t("system.ready") : t("system.notReady")}</Badge>
                <dl className="grid grid-cols-3 gap-2 text-xs">
                  {Object.entries(readiness.data.checks).map(([check, value]) => (
                    <div key={check}>
                      <dt className="text-foreground-muted capitalize">{check}</dt>
                      <dd className={value === "ok" ? "text-status-success-fg" : "text-status-danger-fg"}>{value}</dd>
                    </div>
                  ))}
                </dl>
                <p className="text-xs text-foreground-subtle">{t("system.runtimeState", { state: readiness.data.runtimeState })}</p>
                {readiness.data.worker ? (
                  <p className={`text-sm ${readiness.data.worker.status === "ok" ? "text-foreground-muted" : "font-medium text-status-danger-fg"}`}>
                    {readiness.data.worker.status === "ok" ? t("system.workerOk") : t("system.workerDown")}
                  </p>
                ) : null}
              </>
            )}
          </CardBody>
        </Card>
      </div>

      <JevStatusCard />
      <SyncHealthCards />

      <Card>
        <CardHeader title={t("system.backlogTitle")} />
        <CardBody>
          {stats.isPending ? (
            <LoadingState />
          ) : stats.isError ? (
            <ErrorState error={stats.error} />
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <p className="text-xs text-foreground-muted">{t("system.openReviews")}</p>
                <p className="text-xl font-semibold tabular-nums">{stats.data.review.open}</p>
              </div>
              <div>
                <p className="text-xs text-foreground-muted">{t("system.actionsSucceeded")}</p>
                <p className="text-xl font-semibold tabular-nums">{stats.data.actions.succeeded}</p>
              </div>
              <div>
                <p className="text-xs text-foreground-muted">{t("system.actionsFailed")}</p>
                <p className="text-xl font-semibold tabular-nums">{stats.data.actions.failed}</p>
              </div>
              <div>
                <p className="text-xs text-foreground-muted">{t("system.actionsAmbiguous")}</p>
                <p className="text-xl font-semibold tabular-nums">{stats.data.actions.ambiguous}</p>
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t("system.metrics")} />
        <CardBody>
          {metrics.isPending ? (
            <LoadingState />
          ) : metrics.isError ? (
            <ErrorState error={metrics.error} />
          ) : (
            <JsonViewer data={metrics.data} label={t("system.rawMetrics", { count: metrics.data.counters.length })} />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
