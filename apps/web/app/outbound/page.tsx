"use client";

import { useState } from "react";
import Link from "next/link";
import { useOutboundEmails } from "@/hooks/useOutbound";
import { useHasPermission, useMe } from "@/hooks/useAuth";
import { OUTBOUND_KINDS, type OutboundEmailResponse, type OutboundKind } from "@/lib/api/outbound";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { TableSkeleton } from "@/components/ui/LoadingState";
import { Pagination } from "@/components/ui/Pagination";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { useT } from "@/lib/i18n/I18nProvider";

/** Kinds whose relatedId is one of this organization's emails. */
const EMAIL_KINDS: ReadonlySet<OutboundKind> = new Set(["forward", "auto_reply", "rule_notify"]);

/**
 * 1.2 (F): what Eumaeus sent and whether it went out. The organization's own
 * sends for anyone with audit:read; the system administrator can switch to
 * everything, including system emails (worker status, SMTP tests).
 */
export default function OutboundPage() {
  const t = useT();
  const me = useMe();
  const isSuperAdmin = me.data?.user.isSuperAdmin === true;
  const canRead = useHasPermission("audit:read") === true;
  const [all, setAll] = useState(false);
  const [status, setStatus] = useState<"failed" | undefined>(undefined);
  const [kind, setKind] = useState<OutboundKind | undefined>(undefined);
  const showAll = all && isSuperAdmin;
  const list = useOutboundEmails({ status, kind }, showAll);
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const lastPage = list.data?.pages.at(-1);
  const filtered = Boolean(status || kind);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-lg font-semibold text-foreground">{t("audit.outboundTitle")}</h1>
        <p className="max-w-3xl text-sm text-foreground-muted">{t("audit.outboundSubtitle")}</p>
      </header>

      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface-raised px-2 py-1.5">
        {isSuperAdmin ? (
          <select aria-label={t("audit.outboundScopeAll")} value={showAll ? "all" : "org"} onChange={(e) => setAll(e.target.value === "all")} className="h-7 rounded-md border border-border bg-surface px-2 text-[11px] text-foreground">
            <option value="org">{t("audit.outboundScopeOrg")}</option>
            <option value="all">{t("audit.outboundScopeAll")}</option>
          </select>
        ) : null}
        <select aria-label={t("audit.outboundFailedOnly")} value={status ?? ""} onChange={(e) => setStatus(e.target.value === "failed" ? "failed" : undefined)} className="h-7 rounded-md border border-border bg-surface px-2 text-[11px] text-foreground">
          <option value="">{t("audit.outboundAllStatuses")}</option>
          <option value="failed">{t("audit.outboundFailedOnly")}</option>
        </select>
        <select aria-label={t("audit.outboundAllKinds")} value={kind ?? ""} onChange={(e) => setKind((e.target.value || undefined) as OutboundKind | undefined)} className="h-7 rounded-md border border-border bg-surface px-2 text-[11px] text-foreground">
          <option value="">{t("audit.outboundAllKinds")}</option>
          {OUTBOUND_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`audit.outboundKind_${k}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="rounded-lg border border-border bg-surface-raised">
        {!canRead && !showAll ? (
          <EmptyState title={t("audit.outboundTitle")} description={t("audit.outboundNoPermission")} />
        ) : list.isPending ? (
          <TableSkeleton />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title={filtered ? t("audit.outboundEmptyFiltered") : t("audit.outboundEmpty")} />
        ) : (
          <>
            <ul className="divide-y divide-border">
              {rows.map((row) => (
                <OutboundRow key={row.id} row={row} showOrganization={showAll} />
              ))}
            </ul>
            <div className="px-3 pb-1">
              <Pagination hasMore={Boolean(lastPage?.pagination.hasMore)} loading={list.isFetchingNextPage} onLoadMore={() => list.fetchNextPage()} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function OutboundRow({ row, showOrganization }: { row: OutboundEmailResponse; showOrganization: boolean }) {
  const t = useT();
  const failed = row.status === "failed";
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-3">
      <span className="w-24 shrink-0 pt-0.5 text-xs text-foreground-subtle" title={formatDateTime(row.createdAt)}>
        {formatRelativeTime(row.createdAt)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{row.subject || "—"}</p>
        <p className="truncate text-xs text-foreground-muted">
          {t(`audit.outboundKind_${row.kind}`)} · {t("audit.outboundTo")}: {row.toAddress}
          {showOrganization ? ` · ${row.organization?.name ?? t("audit.outboundSystem")}` : ""}
        </p>
        {failed && row.error ? <p className="mt-0.5 break-words text-xs text-status-danger-fg">{row.error}</p> : null}
      </div>
      {!showOrganization && row.relatedId && EMAIL_KINDS.has(row.kind) ? (
        <Link href={`/emails/${row.relatedId}`} className="shrink-0 pt-0.5 text-xs text-accent hover:underline">
          {t("audit.outboundOpenEmail")}
        </Link>
      ) : null}
      <Badge tone={failed ? "danger" : "success"}>{failed ? t("audit.outboundFailed") : t("audit.outboundSent")}</Badge>
    </li>
  );
}
