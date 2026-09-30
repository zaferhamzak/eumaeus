"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useDeleteEmails, useEmailsList } from "@/hooks/useEmails";
import { useHasPermission } from "@/hooks/useAuth";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ApiRequestError } from "@/lib/api/client";
import { MAX_EMAILS_PER_DELETE } from "@/lib/api/emails";
import { useDestinationsList } from "@/hooks/useDestinations";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Pagination } from "@/components/ui/Pagination";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { TableSkeleton } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/Button";
import { formatRelativeTime } from "@/lib/format";
import { useT } from "@/lib/i18n/I18nProvider";
import { describeStatus } from "@/components/ui/StatusBadge";

const STATE_FILTERS = ["received", "analyzing", "analyzed", "routing", "awaiting_review", "reviewed", "failed"] as const;

/** §35: filters live in the URL (?status=&sender=&subject=, Phase 28: &recipient=&destination=&from=&to=) so refresh/bookmarking/back-forward all work, and no sensitive data is ever encoded there — only values already visible in the list itself. */
export default function EmailsPage() {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <EmailsPageContent />
    </Suspense>
  );
}

function EmailsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useT();

  const state = searchParams.get("status") ?? undefined;
  const sender = searchParams.get("sender") ?? undefined;
  const subject = searchParams.get("subject") ?? undefined;
  // Phase 28: more of the search lives in the URL too.
  const recipient = searchParams.get("recipient") ?? undefined;
  const destination = searchParams.get("destination") ?? undefined;
  const from = validDay(searchParams.get("from"));
  const to = validDay(searchParams.get("to"));
  const destinations = useDestinationsList();

  const emails = useEmailsList({
    state,
    sender,
    subject,
    recipient,
    destination,
    // Whole days in the viewer's own time zone.
    receivedAfter: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
    receivedBefore: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
  });
  const filtered = Boolean(state || sender || subject || recipient || destination || from || to);
  // Deleting selected emails (Eumaeus's copy only) needs the KVKK erasure permission.
  const canDelete = useHasPermission("privacy:erase") === true;
  const remove = useDeleteEmails();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deletedCount, setDeletedCount] = useState<number | null>(null);
  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_EMAILS_PER_DELETE) next.add(id);
      return next;
    });

  // One navigation for all changed keys — two pushes in a row would each start from the old URL and drop the other's change.
  function setFilters(values: Record<string, string | undefined>) {
    setSelected(new Set());
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    router.push(`/emails?${next.toString()}`);
  }
  const setFilter = (key: string, value: string | undefined) => setFilters({ [key]: value });

  const rows = emails.data?.pages.flatMap((page) => page.data) ?? [];
  const visibleIds = rows.map((r) => r.id).slice(0, MAX_EMAILS_PER_DELETE);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const lastPage = emails.data?.pages[emails.data.pages.length - 1];

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-foreground">{t("emails.title")}</h1>
          <p className="text-sm text-foreground-muted">{t("emails.subtitle")}</p>
        </div>
        <Button variant="ghost" onClick={() => emails.refetch()} aria-label={t("emails.refreshList")}>
          {t("emails.refresh")}
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-1.5 border border-border bg-surface-raised px-2 py-1.5 rounded-lg">
        <form
          key={searchParams.toString()} // uncontrolled inputs: reset them when the URL changes (back/forward, "clear")
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const value = (key: string) => ((form.get(key) as string | null) ?? "").trim() || undefined;
            setFilters({ sender: value("sender"), subject: value("subject"), recipient: value("recipient"), destination: value("destination"), from: value("from"), to: value("to") });
          }}
        >
          <label className="sr-only" htmlFor="sender-filter">
            {t("emails.filterBySender")}
          </label>
          <input
            id="sender-filter"
            name="sender"
            type="text"
            placeholder={t("emails.senderPlaceholder")}
            defaultValue={sender ?? ""}
            className="h-7 border border-border bg-surface px-2 text-[11px] text-foreground placeholder:text-foreground-subtle rounded-md"
          />
          <label className="sr-only" htmlFor="subject-filter">
            {t("emails.filterBySubject")}
          </label>
          <input
            id="subject-filter"
            name="subject"
            type="text"
            placeholder={t("emails.subjectPlaceholder")}
            defaultValue={subject ?? ""}
            className="h-7 border border-border bg-surface px-2 text-[11px] text-foreground placeholder:text-foreground-subtle rounded-md"
          />
          <label className="sr-only" htmlFor="recipient-filter">
            {t("emails.filterByRecipient")}
          </label>
          <input
            id="recipient-filter"
            name="recipient"
            type="text"
            placeholder={t("emails.recipientPlaceholder")}
            defaultValue={recipient ?? ""}
            className="h-7 border border-border bg-surface px-2 text-[11px] text-foreground placeholder:text-foreground-subtle rounded-md"
          />
          <label className="sr-only" htmlFor="destination-filter">
            {t("emails.filterByDestination")}
          </label>
          <select id="destination-filter" name="destination" defaultValue={destination ?? ""} className="h-7 border border-border bg-surface px-1 text-[11px] text-foreground rounded-md">
            <option value="">{t("emails.anyDestination")}</option>
            <option value="human_review">{t("emails.destinationHumanReview")}</option>
            <option value="left_alone">{t("emails.destinationLeftAlone")}</option>
            {(destinations.data?.data ?? []).map((d) => (
              <option key={d.id} value={d.name}>
                {d.name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-[11px] text-foreground-muted">
            {t("emails.dateFrom")}
            <input name="from" type="date" defaultValue={from ?? ""} max={to} className="h-7 border border-border bg-surface px-2 text-[11px] text-foreground placeholder:text-foreground-subtle rounded-md" />
          </label>
          <label className="flex items-center gap-1 text-[11px] text-foreground-muted">
            {t("emails.dateTo")}
            <input name="to" type="date" defaultValue={to ?? ""} min={from} className="h-7 border border-border bg-surface px-2 text-[11px] text-foreground placeholder:text-foreground-subtle rounded-md" />
          </label>
          <Button type="submit" variant="secondary" className="h-7 px-2 text-[11px] rounded-md">
            {t("emails.apply")}
          </Button>
          {filtered ? (
            <Button type="button" variant="ghost" className="h-7 px-2 text-[11px] rounded-md" onClick={() => router.push("/emails")}>
              {t("emails.clearFilters")}
            </Button>
          ) : null}
        </form>

        <div className="h-5 w-px bg-border" aria-hidden="true" />

        <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t("emails.filterByState")}>
          <button
            type="button"
            onClick={() => setFilter("status", undefined)}
            className={`h-7 px-2 text-[11px] font-medium rounded-md ${!state ? "border border-accent bg-accent-soft text-accent" : "border border-border bg-surface text-foreground-muted hover:text-foreground"}`}
          >
            {t("emails.allStates")}
          </button>
          {STATE_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setFilter("status", s)}
              aria-pressed={state === s}
              className={`h-7 px-2 text-[11px] font-medium capitalize rounded-md ${state === s ? "border border-accent bg-accent-soft text-accent" : "border border-border bg-surface text-foreground-muted hover:text-foreground"}`}
            >
              {describeStatus(s, t).label}
            </button>
          ))}
        </div>

        <span className="ml-auto font-mono text-[10px] text-foreground-subtle">{t("emails.loaded", { count: rows.length })}</span>
      </div>

      {canDelete && selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border border-status-danger-fg/40 bg-status-danger-bg/40 px-3 py-2 text-sm">
          <span className="font-medium text-foreground">{t("emails.selectedCount", { count: selected.size })}</span>
          <Button variant="danger" className="h-7 px-2 text-xs rounded-md" onClick={() => setConfirmDelete(true)}>
            {t("emails.deleteSelected")}
          </Button>
          <Button variant="ghost" className="h-7 px-2 text-xs rounded-md" onClick={() => setSelected(new Set())}>
            {t("emails.clearSelection")}
          </Button>
          {selected.size >= MAX_EMAILS_PER_DELETE ? <span className="text-xs text-foreground-muted">{t("emails.selectionLimit", { count: MAX_EMAILS_PER_DELETE })}</span> : null}
        </div>
      ) : null}
      {deletedCount !== null ? (
        <p className="border border-status-success-fg/40 bg-status-success-bg px-3 py-2 text-sm text-status-success-fg" role="status">
          {t("emails.deletedBanner", { count: deletedCount })}
        </p>
      ) : null}
      {remove.isError ? (
        <p className="text-sm text-status-danger-fg" role="alert">
          {remove.error instanceof ApiRequestError ? remove.error.message : t("emails.deleteFailed")}
        </p>
      ) : null}

      <div className="overflow-hidden border border-border bg-surface-raised rounded-lg">
        {emails.isPending ? (
          <TableSkeleton />
        ) : emails.isError ? (
          <ErrorState error={emails.error} onRetry={() => emails.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={filtered ? t("emails.emptyFilteredTitle") : t("emails.emptyTitle")}
            description={filtered ? t("emails.emptyFilteredDescription") : t("emails.emptyDescription")}
          />
        ) : (
          <>
            <Table>
              <Thead>
                <Tr className="hover:bg-transparent">
                  {canDelete ? (
                    <Th className="w-[28px]">
                      <Checkbox
                        checked={allSelected}
                        aria-label={t("emails.selectAll")}
                        onChange={() => setSelected(allSelected ? new Set() : new Set(visibleIds))}
                      />
                    </Th>
                  ) : null}
                  <Th className="w-[110px] text-[10px]">{t("emails.colReceived")}</Th>
                  <Th className="text-[10px]">{t("emails.colSenderSubject")}</Th>
                  <Th className="w-[150px] text-[10px]">{t("emails.colState")}</Th>
                  <Th className="w-[10px]" aria-label={t("emails.colOpen")} />
                </Tr>
              </Thead>
              <Tbody>
                {rows.map((email) => (
                  <Tr key={email.id} className="group cursor-pointer">
                    {canDelete ? (
                      <Td>
                        <Checkbox checked={selected.has(email.id)} aria-label={t("emails.selectEmail", { subject: email.subject || t("emails.emailFallback") })} onChange={() => toggle(email.id)} />
                      </Td>
                    ) : null}
                    <Td className="whitespace-nowrap font-mono text-[10.5px] text-foreground-muted">{formatRelativeTime(email.receivedAt)}</Td>
                    <Td className="max-w-0">
                      <Link href={`/emails/${email.id}`} className="block truncate text-sm font-medium text-foreground group-hover:text-accent group-hover:underline">
                        {email.subject || t("emails.noSubject")}
                      </Link>
                      <span className="block truncate text-xs text-foreground-muted">{email.fromAddress}</span>
                    </Td>
                    <Td>
                      <StatusBadge status={email.state} dense />
                    </Td>
                    <Td>
                      <Link href={`/emails/${email.id}`} aria-label={t("emails.openEmail", { subject: email.subject || t("emails.emailFallback") })} className="text-foreground-subtle group-hover:text-accent">
                        →
                      </Link>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
            <Pagination
              hasMore={Boolean(lastPage?.pagination.hasMore)}
              loading={emails.isFetchingNextPage}
              onLoadMore={() => emails.fetchNextPage()}
            />
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title={t("emails.deleteConfirmTitle", { count: selected.size })}
        description={t("emails.deleteConfirmDescription")}
        confirmLabel={t("emails.deleteSelected")}
        loading={remove.isPending}
        onConfirm={() =>
          remove.mutate([...selected], {
            onSuccess: (result) => {
              setDeletedCount(result.deleted);
              setSelected(new Set());
              setConfirmDelete(false);
            },
            onError: () => setConfirmDelete(false),
          })
        }
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

/** A YYYY-MM-DD from the URL, or undefined — anything else is ignored rather than sent to the API. */
function validDay(value: string | null): string | undefined {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime()) ? value : undefined;
}
