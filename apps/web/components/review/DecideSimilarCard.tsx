"use client";

import { useState } from "react";
import Link from "next/link";
import { useBulkResolveReviews, useSimilarReviews } from "@/hooks/useReviews";
import type { ReviewResolution } from "@/lib/api/review";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ApiRequestError } from "@/lib/api/client";
import { formatRelativeTime } from "@/lib/format";
import { useT } from "@/lib/i18n/I18nProvider";

const SHOWN = 20;

/**
 * Phase 23: the other open review items from the same sender (optionally
 * narrowed to a word of this item's subject), decided together in one bulk
 * request. The list comes from the backend; nothing here guesses which
 * emails are "similar".
 */
export function DecideSimilarCard({ reviewId, currentOpen, canResolve }: { reviewId: string; currentOpen: boolean; canResolve: boolean }) {
  const t = useT();
  const [word, setWord] = useState<string | null>(null);
  const [includeCurrent, setIncludeCurrent] = useState(true);
  const [pending, setPending] = useState<ReviewResolution | null>(null);
  const similar = useSimilarReviews(reviewId, word);
  const bulk = useBulkResolveReviews();

  if (!similar.data) return null;
  const { sender, words, items, truncated } = similar.data;
  // Nothing from this sender and no narrowing active: the card would only say "none".
  if (items.length === 0 && word === null && !bulk.isSuccess) return null;

  const ids = [...(currentOpen && includeCurrent ? [reviewId] : []), ...items.map((i) => i.id)];
  const count = ids.length;

  function decide(resolution: ReviewResolution) {
    bulk.mutate({ itemIds: ids, resolution }, { onSettled: () => setPending(null) });
  }

  return (
    <Card>
      <CardHeader title={t("review.similarCardTitle")} />
      <CardBody className="space-y-3">
        <p className="text-sm text-foreground">
          {t.rich(truncated ? "review.similarCountMore" : "review.similarCount", { b: (c) => <span className="font-medium break-all">{c}</span> }, { count: items.length, sender })}
        </p>

        {words.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t("review.similarNarrow")}>
            <span className="mr-1 text-[10.5px] text-foreground-subtle">{t("review.similarNarrow")}</span>
            {words.map((w) => (
              <button
                key={w}
                type="button"
                aria-pressed={word === w}
                onClick={() => setWord(word === w ? null : w)}
                className={`h-6 px-2 text-[11px] ${
                  word === w ? "border border-accent bg-accent-soft text-accent" : "border border-border bg-surface text-foreground-muted hover:text-foreground"
                }`}
              >
                {w}
              </button>
            ))}
          </div>
        ) : null}

        {items.length === 0 ? (
          <p className="text-xs text-foreground-muted">{t("review.similarNoneForWord")}</p>
        ) : (
          <ul className="divide-y divide-border border border-border">
            {items.slice(0, SHOWN).map((item) => (
              <li key={item.id} className="grid grid-cols-[1fr_auto] gap-2 px-2 py-1.5">
                <div className="min-w-0">
                  <Link href={`/review/${item.id}`} className="block truncate text-xs font-medium text-foreground hover:text-accent hover:underline">
                    {item.subject || t("review.noSubject")}
                  </Link>
                  <p className="truncate text-[10.5px] text-foreground-subtle">{item.fromAddress}</p>
                </div>
                <span className="font-mono text-[10.5px] whitespace-nowrap text-foreground-muted">{formatRelativeTime(item.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
        {items.length > SHOWN ? <p className="text-[10.5px] text-foreground-subtle">{t("review.similarMore", { count: items.length - SHOWN })}</p> : null}

        {canResolve && items.length > 0 ? (
          <div className="space-y-2">
            {currentOpen ? (
              <label className="flex items-center gap-2 text-xs text-foreground-muted">
                <Checkbox checked={includeCurrent} onChange={() => setIncludeCurrent((v) => !v)} />
                {t("review.similarIncludeCurrent")}
              </label>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button variant="danger" loading={bulk.isPending} disabled={similar.isPlaceholderData} onClick={() => setPending("spam")}>
                {t("review.similarMarkAllSpam")}
              </Button>
              <Button variant="secondary" loading={bulk.isPending} disabled={similar.isPlaceholderData} onClick={() => setPending("approved")}>
                {t("review.similarMarkAllApproved")}
              </Button>
            </div>
          </div>
        ) : null}

        {bulk.isSuccess ? (
          <p className="text-xs text-status-success-fg" role="status">
            {t("review.similarDone", {
              count: bulk.data.resolved,
              skipped: bulk.data.skipped,
            })}
          </p>
        ) : null}
        {bulk.isError ? (
          <p className="text-xs text-status-danger-fg" role="alert">
            {bulk.error instanceof ApiRequestError ? bulk.error.message : t("review.bulkResolveFailed")}
          </p>
        ) : null}
      </CardBody>

      <ConfirmDialog
        open={pending !== null}
        title={pending === "spam" ? t("review.similarSpamConfirmTitle", { count }) : t("review.similarApproveConfirmTitle", { count })}
        description={t("review.bulkConfirmDescription")}
        confirmLabel={pending === "spam" ? t("review.similarMarkAllSpam") : t("review.similarMarkAllApproved")}
        confirmVariant={pending === "spam" ? "danger" : "primary"}
        loading={bulk.isPending}
        onConfirm={() => pending && decide(pending)}
        onCancel={() => setPending(null)}
      />
    </Card>
  );
}
