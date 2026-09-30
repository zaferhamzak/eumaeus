"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuditList } from "@/hooks/useAudit";
import { Pagination } from "@/components/ui/Pagination";
import { ErrorState } from "@/components/ui/ErrorState";
import { TableSkeleton } from "@/components/ui/LoadingState";
import { AuditEventList } from "@/components/audit/AuditEventList";
import { AUDIT_EVENT_COPY } from "@/lib/auditEventCopy";
import { AuditExport } from "@/components/audit/AuditExport";
import { useT } from "@/lib/i18n/I18nProvider";

/** §21: a readable, filterable, read-only event stream — payloads are collapsed by default (JsonViewer) since most operators just need the "what happened, when, to which email" summary. */
export default function AuditPage() {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <AuditPageContent />
    </Suspense>
  );
}

function AuditPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useT();
  const eventType = searchParams.get("eventType") ?? undefined;
  const emailId = searchParams.get("emailId") ?? undefined;

  const audit = useAuditList({ eventType, emailId });

  function setParam(key: string, value: string | undefined) {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.push(`/audit?${next.toString()}`);
  }

  const rows = audit.data?.pages.flatMap((p) => p.data) ?? [];
  const lastPage = audit.data?.pages[audit.data.pages.length - 1];

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">{t("audit.title")}</h1>
          <p className="text-sm text-foreground-muted">
            {t("audit.subtitle")}
          </p>
        </div>
        <AuditExport eventType={eventType} />
      </header>

      <div className="flex flex-wrap items-center gap-1.5 border border-border bg-surface-raised px-2 py-1.5 rounded-lg">
        <label className="sr-only" htmlFor="event-type-filter">
          {t("audit.filterByEventType")}
        </label>
        <select
          id="event-type-filter"
          value={eventType ?? ""}
          onChange={(e) => setParam("eventType", e.target.value || undefined)}
          className="h-7 border border-border bg-surface px-2 text-[11px] text-foreground rounded-md"
        >
          <option value="">{t("audit.allEventTypes")}</option>
          {Object.keys(AUDIT_EVENT_COPY).map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>

        {emailId ? (
          <span className="flex h-7 items-center gap-1.5 border border-accent bg-accent-soft px-2 font-mono text-[10.5px] text-accent rounded-md">
            {t("audit.emailFilter", { id: emailId.slice(0, 8) })}
            <button
              type="button"
              onClick={() => setParam("emailId", undefined)}
              aria-label={t("audit.clearEmailFilter")}
            >
              ✕
            </button>
          </span>
        ) : null}

        <span className="ml-auto font-mono text-[10px] text-foreground-subtle">
          {t("audit.loaded", { count: rows.length })}
        </span>
      </div>

      <div className="border border-border bg-surface-raised px-3 pt-1 rounded-lg">
        {audit.isPending ? (
          <TableSkeleton />
        ) : audit.isError ? (
          <ErrorState error={audit.error} onRetry={() => audit.refetch()} />
        ) : (
          <>
            <AuditEventList
              events={rows}
              emptyMessage={t("audit.emptyFiltered")}
              showEmailLinks
            />
            {rows.length > 0 ? (
              <div className="pb-1">
                <Pagination
                  hasMore={Boolean(lastPage?.pagination.hasMore)}
                  loading={audit.isFetchingNextPage}
                  onLoadMore={() => audit.fetchNextPage()}
                />
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
