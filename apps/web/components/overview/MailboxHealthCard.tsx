"use client";

import Link from "next/link";
import { useMailboxHealth } from "@/hooks/useOps";
import { useHasPermission } from "@/hooks/useAuth";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/LoadingState";
import { formatRelativeTime } from "@/lib/format";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MailboxHealthResponse } from "@/lib/api/ops";
import { LiveIndicator } from "@/components/system/LiveIndicator";

const TONE: Record<MailboxHealthResponse["health"], BadgeTone> = { ok: "success", failing: "danger", needs_sign_in: "warning", never_synced: "info", disabled: "neutral" };

/** Is mail coming in? The organization's mailboxes, problems first (same data as the System page). */
export function MailboxHealthCard() {
  const t = useT();
  const canSee = useHasPermission("mailboxes:read") === true;
  const health = useMailboxHealth(canSee);
  if (!canSee) return null;
  const rows = (health.data?.data ?? []).filter((m) => m.health !== "disabled").slice(0, 6);
  return (
    <Card className="flex h-full min-h-[260px] flex-col">
      <CardHeader
        title={t("overview.mailboxesTitle")}
        action={
          <Link href="/mailboxes" className="text-xs text-accent hover:underline">
            {t("overview.viewAll")}
          </Link>
        }
      />
      {health.isPending ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-full" />
        </div>
      ) : health.isError ? (
        <ErrorState error={health.error} onRetry={() => health.refetch()} />
      ) : rows.length === 0 ? (
        <p className="flex flex-1 items-center justify-center px-4 py-8 text-center text-sm text-foreground-muted">{t("overview.mailboxesNone")}</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{m.name ?? m.emailAddress}</p>
                <p className="truncate text-xs text-foreground-muted">
                  {m.health === "failing" || m.health === "needs_sign_in"
                    ? m.consecutiveFailures > 1
                      ? t("system.syncStreak", { count: m.consecutiveFailures })
                      : (m.lastSyncError ?? "")
                    : m.lastSyncSuccessAt
                      ? t("system.syncLastOk", { time: formatRelativeTime(m.lastSyncSuccessAt) })
                      : t("system.syncNeverOk")}
                </p>
              </div>
              {m.live ? <LiveIndicator /> : null}
              <Badge tone={TONE[m.health]}>{t(`system.health_${m.health}`)}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
