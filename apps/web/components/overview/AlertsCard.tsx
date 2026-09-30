"use client";

import { useAlerts, useDismissAlert } from "@/hooks/useOps";
import { useHasPermission } from "@/hooks/useAuth";
import { Icon } from "@/components/ui/Icon";
import { ApiRequestError } from "@/lib/api/client";
import { formatRelativeTime } from "@/lib/format";
import { useT } from "@/lib/i18n/I18nProvider";
import { alertText } from "@/lib/alertText";

/**
 * Phase 18: open operational alerts, at the top of the Overview. Absent when
 * nothing is wrong. People who receive alert emails (organizations:write) can
 * dismiss one: it stays hidden while the problem lasts and a recurrence after
 * it clears opens a new alert (see the API's evaluateAlerts.ts).
 */
export function AlertsCard() {
  const alerts = useAlerts("open");
  const dismiss = useDismissAlert();
  const canDismiss = useHasPermission("organizations:write") === true;
  const t = useT();
  const rows = alerts.data?.data ?? [];
  if (rows.length === 0) return null;
  return (
    <section className="border border-status-danger-fg/40 bg-status-danger-bg/60" aria-labelledby="alerts-title">
      <h2 id="alerts-title" className="flex items-center gap-2 border-b border-status-danger-fg/20 px-4 py-2 text-sm font-semibold text-status-danger-fg">
        <Icon name="alert" size={14} /> {t("overview.alertsTitle", { count: rows.length })}
      </h2>
      <ul className="divide-y divide-status-danger-fg/15">
        {rows.map((a) => {
          const text = alertText(a, t);
          return (
          <li key={a.id} className="flex items-start gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">{text.title}</p>
              <p className="break-words text-xs text-foreground-muted">{text.detail}</p>
              <p className="mt-0.5 text-[11px] text-foreground-subtle">{t("overview.alertSince", { time: formatRelativeTime(a.firstSeenAt) })}</p>
            </div>
            {canDismiss ? (
              <button
                type="button"
                onClick={() => dismiss.mutate(a.id)}
                disabled={dismiss.isPending && dismiss.variables === a.id}
                aria-label={t("overview.alertDismissAria", { title: text.title })}
                title={t("overview.alertDismissHint")}
                className="shrink-0 border border-status-danger-fg/30 px-2 py-0.5 text-[11px] font-medium text-foreground-muted hover:bg-surface hover:text-foreground disabled:opacity-50"
              >
                {t("overview.alertDismiss")}
              </button>
            ) : null}
          </li>
          );
        })}
      </ul>
      {dismiss.isError ? (
        <p className="border-t border-status-danger-fg/20 px-4 py-2 text-xs text-status-danger-fg" role="alert">
          {dismiss.error instanceof ApiRequestError ? dismiss.error.message : t("overview.alertDismissFailed")}
        </p>
      ) : null}
    </section>
  );
}
