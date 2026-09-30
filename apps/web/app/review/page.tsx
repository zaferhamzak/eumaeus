"use client";

import { SuggestionsPanel } from "@/components/senderLists/SuggestionsPanel";
import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useBulkResolveReviews, useReviewsList } from "@/hooks/useReviews";
import { useHasPermission } from "@/hooks/useAuth";
import type { ReviewResolution } from "@/lib/api/review";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Pagination } from "@/components/ui/Pagination";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { TableSkeleton } from "@/components/ui/LoadingState";
import { ApiRequestError } from "@/lib/api/client";
import { SignalBadge } from "@/components/review/SignalBadge";
import { Checkbox } from "@/components/ui/Checkbox";
import { formatRelativeTime } from "@/lib/format";
import type { ReviewItemResponse } from "@/types/api";
import { useT } from "@/lib/i18n/I18nProvider";
import type { Translate } from "@/lib/i18n/translate";
import { describeStatus } from "@/components/ui/StatusBadge";
import { reviewReasonLabel } from "@/components/review/reviewReason";
import type { MessageKey } from "@/lib/i18n/messages";

const REASONS = ["failed", "unmatched", "ambiguous", "low_confidence", "manual_review_requested", "execution_failed", "execution_ambiguous"];

const SHORTCUTS: Array<{ keys: string[]; label: MessageKey; needsResolve?: boolean }> = [
  { keys: ["j", "k"], label: "review.shortcutMove" },
  { keys: ["Enter"], label: "review.shortcutOpen" },
  { keys: ["s"], label: "review.shortcutSpam", needsResolve: true },
  { keys: ["a"], label: "review.shortcutApprove", needsResolve: true },
  { keys: ["x"], label: "review.shortcutSelect", needsResolve: true },
  { keys: ["?"], label: "review.shortcutHelp" },
];

/** Keys typed into a text field, a select or an editable region are the user's text, not shortcuts. Checkboxes/buttons don't take text, so shortcuts still work after clicking one. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "reset"].includes(type);
  }
  return false;
}

/** Built entirely from real fields already on the item — the reason, Jev's real category choice, and its real spam probability — never a generated/invented summary sentence. */
function reviewDescription(item: ReviewItemResponse, t: Translate): string {
  const parts = [reviewReasonLabel(item.reason, t)];
  if (item.signal?.category) parts.push(item.signal.category.replace(/_/g, " "));
  if (item.signal?.isSpam !== null && item.signal?.isSpam !== undefined) parts.push(t("review.spamProbability", { percent: Math.round(item.signal.isSpam * 100) }));
  return parts.join(" · ");
}

/** §14: Human Review as a first-class workflow, not a generic list — default filter is "open" (the actual backlog an operator cares about), with "resolved" one click away. */
export default function ReviewPage() {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <ReviewPageContent />
    </Suspense>
  );
}

function ReviewPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useT();
  const canResolve = useHasPermission("reviews:resolve") === true;
  const bulkResolve = useBulkResolveReviews();
  const status = (searchParams.get("status") as "open" | "resolved" | null) ?? "open";
  const reason = searchParams.get("reason") ?? undefined;
  // Phase 28: "me" | "none" | absent (everyone).
  const assigned = searchParams.get("assigned") === "me" || searchParams.get("assigned") === "none" ? (searchParams.get("assigned") as "me" | "none") : undefined;

  const reviews = useReviewsList({ status, reason, assignedTo: assigned });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState<ReviewResolution | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const [showHelp, setShowHelp] = useState(false);

  function setParam(key: string, value: string | undefined) {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.push(`/review?${next.toString()}`);
  }

  const rows = reviews.data?.pages.flatMap((p) => p.data) ?? [];
  const lastPage = reviews.data?.pages[reviews.data.pages.length - 1];
  const openRows = rows.filter((r) => r.status === "open");
  const allOpenSelected = openRows.length > 0 && openRows.every((r) => selected.has(r.id));
  // Clamped at render: when a decided item drops out of the "open" list, the highlight stays at the same position — i.e. moves on to the next item.
  const highlightIndex = rows.length === 0 ? -1 : Math.min(Math.max(highlighted, 0), rows.length - 1);
  const highlightedItem = highlightIndex >= 0 ? rows[highlightIndex] : undefined;

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allOpenSelected ? new Set() : new Set(openRows.map((r) => r.id)));
  }

  /** POST /reviews/resolve (bulk) — items already closed by someone else are skipped by the backend. */
  async function runBulkResolve(resolution: ReviewResolution, ids: string[] = [...selected]) {
    setBulkRunning(true);
    setBulkError(null);
    try {
      await bulkResolve.mutateAsync({ itemIds: ids, resolution });
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    } catch (error) {
      setBulkError(error instanceof ApiRequestError ? error.message : t("review.bulkResolveFailed"));
    } finally {
      setBulkRunning(false);
      setConfirmBulk(null);
    }
  }

  // Latest-render handler behind a stable listener, so the effect doesn't re-subscribe on every render.
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    onKeyRef.current = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      if (confirmBulk !== null) return; // a dialog is open
      if (e.key === "?") {
        e.preventDefault();
        setShowHelp((v) => !v);
        return;
      }
      if (e.key === "Escape" && showHelp) {
        setShowHelp(false);
        return;
      }
      if (rows.length === 0) return;
      const move = (to: number) => {
        const next = Math.min(Math.max(to, 0), rows.length - 1);
        setHighlighted(next);
        document.querySelector(`[data-review-row="${rows[next]!.id}"]`)?.scrollIntoView?.({ block: "nearest" });
      };
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        move(highlightIndex + 1);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        move(highlightIndex - 1);
      } else if (e.key === "Enter" && highlightedItem) {
        // Enter on a focused link/button keeps its own meaning.
        if (e.target instanceof HTMLElement && e.target.closest("a, button")) return;
        e.preventDefault();
        router.push(`/review/${highlightedItem.id}`);
      } else if ((e.key === "s" || e.key === "a") && highlightedItem && canResolve && highlightedItem.status === "open" && !bulkRunning) {
        e.preventDefault();
        void runBulkResolve(e.key === "s" ? "spam" : "approved", [highlightedItem.id]);
      } else if (e.key === "x" && highlightedItem && canResolve && highlightedItem.status === "open") {
        e.preventDefault();
        toggleOne(highlightedItem.id);
      }
    };
  });
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKeyRef.current(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-lg font-semibold text-foreground">{t("review.title")}</h1>
        <p className="text-sm text-foreground-muted">{t("review.subtitle")}</p>
      </header>

      {/* Only shown when there's something to suggest. */}
      <SuggestionsPanel compact />

      <div className="flex flex-wrap items-center gap-1.5 border border-border bg-surface-raised px-2 py-1.5 rounded-lg">
        <div className="flex gap-1" role="group" aria-label={t("review.filterByStatus")}>
          {(["open", "resolved"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={status === s}
              onClick={() => {
                setSelected(new Set());
                setParam("status", s);
              }}
              className={`h-7 px-2 text-[11px] font-medium capitalize rounded-md ${
                status === s ? "border border-accent bg-accent-soft text-accent" : "border border-border bg-surface text-foreground-muted hover:text-foreground"
              }`}
            >
              {describeStatus(s, t).label}
            </button>
          ))}
        </div>

        <div className="h-5 w-px bg-border" aria-hidden="true" />

        <div className="flex gap-1" role="group" aria-label={t("review.filterByAssignee")}>
          {([undefined, "me", "none"] as const).map((a) => (
            <button
              key={a ?? "all"}
              type="button"
              aria-pressed={assigned === a}
              onClick={() => {
                setSelected(new Set());
                setParam("assigned", a);
              }}
              className={`h-7 px-2 text-[11px] font-medium rounded-md ${
                assigned === a ? "border border-accent bg-accent-soft text-accent" : "border border-border bg-surface text-foreground-muted hover:text-foreground"
              }`}
            >
              {a === "me" ? t("review.assignedToMe") : a === "none" ? t("review.unassigned") : t("review.assignedAnyone")}
            </button>
          ))}
        </div>

        <div className="h-5 w-px bg-border" aria-hidden="true" />

        <label className="sr-only" htmlFor="reason-filter">
          {t("review.filterByReason")}
        </label>
        <select
          id="reason-filter"
          value={reason ?? ""}
          onChange={(e) => setParam("reason", e.target.value || undefined)}
          className="h-7 border border-border bg-surface px-2 text-[11px] text-foreground rounded-md"
        >
          <option value="">{t("review.allReasons")}</option>
          {REASONS.map((r) => (
            <option key={r} value={r}>
              {reviewReasonLabel(r, t)}
            </option>
          ))}
        </select>

        <span className="ml-auto font-mono text-[10px] text-foreground-subtle">{t("review.loaded", { count: rows.length })}</span>
        <button
          type="button"
          onClick={() => setShowHelp((v) => !v)}
          aria-expanded={showHelp}
          aria-controls="review-shortcuts"
          className="h-7 border border-border bg-surface px-2 font-mono text-[10px] text-foreground-muted hover:text-foreground rounded-md"
          title={t("review.shortcutsTitle")}
        >
          ?<span className="sr-only">{t("review.shortcutsTitle")}</span>
        </button>
      </div>

      {showHelp ? (
        <div id="review-shortcuts" role="region" aria-label={t("review.shortcutsTitle")} className="border border-border bg-surface-raised px-3 py-2 rounded-lg">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-semibold text-foreground">{t("review.shortcutsTitle")}</span>
            <button type="button" onClick={() => setShowHelp(false)} className="text-[10.5px] text-foreground-subtle hover:text-accent">
              {t("review.shortcutsClose")}
            </button>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
            {SHORTCUTS.filter((s) => canResolve || !s.needsResolve).map((s) => (
              <div key={s.label} className="contents">
                <dt className="flex gap-1">
                  {s.keys.map((k) => (
                    <kbd key={k} className="border border-border bg-surface px-1 font-mono text-[10px] text-foreground">
                      {k}
                    </kbd>
                  ))}
                </dt>
                <dd className="text-foreground-muted">{t(s.label)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {bulkError && selected.size === 0 ? (
        <p className="border border-status-danger-fg bg-status-danger-bg px-2 py-1.5 text-[11px] text-status-danger-fg" role="alert">
          {bulkError}
        </p>
      ) : null}

      {selected.size > 0 && canResolve ? (
        <div className="flex flex-wrap items-center gap-2 border border-accent bg-accent-soft px-2 py-1.5">
          <span className="text-[11px] font-medium text-accent">{t("review.selectedCount", { count: selected.size })}</span>
          <Button variant="secondary" loading={bulkRunning} onClick={() => setConfirmBulk("approved")}>
            {t("review.approveSelected")}
          </Button>
          <Button variant="danger" loading={bulkRunning} onClick={() => setConfirmBulk("spam")}>
            {t("review.markSelectedSpam")}
          </Button>
          <Button variant="ghost" onClick={() => setSelected(new Set())}>
            {t("review.clearSelection")}
          </Button>
          {bulkError ? <span className="text-[11px] text-status-danger-fg">{bulkError}</span> : null}
        </div>
      ) : null}

      <div className="overflow-hidden border border-border bg-surface-raised rounded-lg">
        {reviews.isPending ? (
          <TableSkeleton />
        ) : reviews.isError ? (
          <ErrorState error={reviews.error} onRetry={() => reviews.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title={status === "open" ? t("review.emptyOpen") : t("review.emptyResolved")} />
        ) : (
          <>
            <Table>
              <Thead>
                <Tr className="hover:bg-transparent">
                  <Th className="w-[32px]">
                    {status === "open" && canResolve ? (
                      <Checkbox
                        checked={allOpenSelected}
                        indeterminate={selected.size > 0 && !allOpenSelected}
                        onChange={toggleAll}
                        aria-label={t("review.selectAll")}
                      />
                    ) : null}
                  </Th>
                  <Th className="w-[90px] text-[10px]">{t("review.colStatus")}</Th>
                  <Th className="text-[10px]">{t("review.colReason")}</Th>
                  <Th className="w-[120px] text-[10px]">{t("review.colSignal")}</Th>
                  <Th className="w-[90px] text-[10px]">{t("review.colCreated")}</Th>
                  <Th className="w-[10px]" aria-label={t("review.colOpen")} />
                </Tr>
              </Thead>
              <Tbody>
                {rows.map((item, index) => (
                  <Tr
                    key={item.id}
                    data-review-row={item.id}
                    onClick={() => setHighlighted(index)}
                    aria-current={index === highlightIndex ? "true" : undefined}
                    className={`group ${index === highlightIndex ? "bg-accent-soft shadow-[inset_3px_0_0_var(--accent-bright)]" : ""}`}
                  >
                    <Td>
                      {item.status === "open" && canResolve ? (
                        <Checkbox
                          checked={selected.has(item.id)}
                          onChange={() => toggleOne(item.id)}
                          aria-label={t("review.selectItem", { subject: item.emailPreview?.subject ?? item.reason })}
                        />
                      ) : null}
                    </Td>
                    <Td>
                      <StatusBadge status={item.status} dense />
                    </Td>
                    <Td className="max-w-0">
                      <Link href={`/review/${item.id}`} className="block truncate text-sm font-medium text-foreground capitalize group-hover:text-accent group-hover:underline">
                        {item.emailPreview?.subject || reviewReasonLabel(item.reason, t)}
                      </Link>
                      <p className="truncate text-[10.5px] text-foreground-subtle">{reviewDescription(item, t)}</p>
                      {item.assignedToEmail ? <p className="truncate text-[10.5px] text-foreground-muted">{t("review.assignedToShort", { email: item.assignedToEmail })}</p> : null}
                      <Link href={`/emails/${item.emailId}`} className="text-[10.5px] text-foreground-subtle hover:text-accent hover:underline">
                        {t("review.viewEmail")}
                      </Link>
                    </Td>
                    <Td>
                      <SignalBadge signal={item.signal} />
                    </Td>
                    <Td className="whitespace-nowrap font-mono text-[10.5px] text-foreground-muted">{formatRelativeTime(item.createdAt)}</Td>
                    <Td>
                      <Link href={`/review/${item.id}`} aria-label={t("review.openReview", { reason: reviewReasonLabel(item.reason, t) })} className="text-foreground-subtle group-hover:text-accent">
                        →
                      </Link>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
            <Pagination hasMore={Boolean(lastPage?.pagination.hasMore)} loading={reviews.isFetchingNextPage} onLoadMore={() => reviews.fetchNextPage()} />
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmBulk !== null}
        title={confirmBulk === "spam" ? t("review.bulkSpamConfirmTitle", { count: selected.size }) : t("review.bulkApproveConfirmTitle", { count: selected.size })}
        description={t("review.bulkConfirmDescription")}
        confirmLabel={confirmBulk === "spam" ? t("review.markAsSpam") : t("review.approve")}
        confirmVariant={confirmBulk === "spam" ? "danger" : "primary"}
        loading={bulkRunning}
        onConfirm={() => confirmBulk && runBulkResolve(confirmBulk)}
        onCancel={() => setConfirmBulk(null)}
      />
    </div>
  );
}
