"use client";

import { useMailboxHealth, useQueueHealth } from "@/hooks/useOps";
import { useHasPermission, useMe } from "@/hooks/useAuth";
import type { MailboxHealthResponse } from "@/lib/api/ops";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { LiveIndicator } from "@/components/system/LiveIndicator";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { formatRelativeTime } from "@/lib/format";
import { useT } from "@/lib/i18n/I18nProvider";

const HEALTH_TONE: Record<MailboxHealthResponse["health"], BadgeTone> = {
  ok: "success",
  failing: "danger",
  needs_sign_in: "warning",
  never_synced: "info",
  disabled: "neutral",
};

/**
 * Phase 26: is mail actually coming in? The organization's mailboxes with
 * their last good and last failed sync, problems first (anyone who can see
 * mailboxes). Below it, for the system administrator only, every job queue's
 * counts and latest failures — what used to need redis-cli.
 */
export function SyncHealthCards() {
  const t = useT();
  const canSee = useHasPermission("mailboxes:read") === true;
  const me = useMe();
  const isSuperAdmin = me.data?.user.isSuperAdmin === true;
  const mailboxes = useMailboxHealth(canSee);
  const queues = useQueueHealth(isSuperAdmin);

  return (
    <>
      {canSee ? (
        <Card>
          <CardHeader title={t("system.syncTitle")} />
          <CardBody className="space-y-2">
            <p className="text-xs text-foreground-muted">{t("system.syncSubtitle")}</p>
            {mailboxes.isPending ? (
              <LoadingState />
            ) : mailboxes.isError ? (
              <ErrorState error={mailboxes.error} />
            ) : mailboxes.data.data.length === 0 ? (
              <p className="text-sm text-foreground-muted">{t("system.syncNone")}</p>
            ) : (
              <ul className="divide-y divide-border">
                {mailboxes.data.data.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{m.name ?? m.emailAddress}</p>
                      {m.name ? <p className="truncate text-xs text-foreground-muted">{m.emailAddress}</p> : null}
                      {m.health === "failing" || m.health === "needs_sign_in" ? (
                        m.lastSyncError ? <p className="mt-0.5 break-words text-xs text-status-danger-fg">{m.lastSyncError}</p> : null
                      ) : null}
                    </div>
                    <div className="text-right text-xs text-foreground-muted">
                      <p>{m.lastSyncSuccessAt ? t("system.syncLastOk", { time: formatRelativeTime(m.lastSyncSuccessAt) }) : t("system.syncNeverOk")}</p>
                      {m.lastSyncFailureAt ? <p>{t("system.syncLastFail", { time: formatRelativeTime(m.lastSyncFailureAt) })}</p> : null}
                      {m.consecutiveFailures > 1 ? <p className="font-medium text-status-danger-fg">{t("system.syncStreak", { count: m.consecutiveFailures })}</p> : null}
                    </div>
                    <div className="flex items-center gap-2">
                      {m.live ? <LiveIndicator /> : null}
                      <Badge tone={HEALTH_TONE[m.health]}>{t(`system.health_${m.health}`)}</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      ) : null}

      {isSuperAdmin ? (
        <Card>
          <CardHeader title={t("system.queuesTitle")} />
          <CardBody className="space-y-2">
            <p className="text-xs text-foreground-muted">{t("system.queuesSubtitle")}</p>
            {queues.isPending ? (
              <LoadingState />
            ) : queues.isError ? (
              <ErrorState error={queues.error} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-foreground-muted">
                      <th className="py-1 pr-3 font-medium">{t("system.queueName")}</th>
                      <th className="py-1 pr-3 text-right font-medium">{t("system.queueWaiting")}</th>
                      <th className="py-1 pr-3 text-right font-medium">{t("system.queueActive")}</th>
                      <th className="py-1 pr-3 text-right font-medium">{t("system.queueDelayed")}</th>
                      <th className="py-1 text-right font-medium">{t("system.queueFailed")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {queues.data.data.map((q) => (
                      <tr key={q.name}>
                        <td className="py-1.5 pr-3 font-mono text-xs">{q.name}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{q.counts.waiting}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{q.counts.active}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{q.counts.delayed}</td>
                        <td className={`py-1.5 text-right tabular-nums ${q.counts.failed > 0 ? "font-semibold text-status-danger-fg" : ""}`}>{q.counts.failed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {queues.data.data.some((q) => q.recentFailures.length > 0) ? (
                  <div className="mt-4 space-y-2">
                    <h3 className="text-xs font-semibold text-foreground-muted">{t("system.queueRecentFailures")}</h3>
                    <ul className="space-y-1.5">
                      {queues.data.data.flatMap((q) =>
                        q.recentFailures.map((f) => (
                          <li key={`${q.name}:${f.id}`} className="text-xs">
                            <span className="font-mono text-foreground">{q.name}</span>
                            {f.failedAt ? <span className="text-foreground-subtle"> · {formatRelativeTime(f.failedAt)}</span> : null}
                            <span className="text-foreground-subtle"> · {t("system.queueAttempts", { count: f.attempts })}</span>
                            <p className="break-words text-status-danger-fg">{f.reason || "—"}</p>
                          </li>
                        )),
                      )}
                    </ul>
                  </div>
                ) : null}
                <p className="mt-3 text-xs text-foreground-subtle">{t("system.queueCleanupNote")}</p>
              </div>
            )}
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}
