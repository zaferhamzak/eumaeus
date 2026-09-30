"use client";

import Link from "next/link";
import { useResolveReview, useReviewsList } from "@/hooks/useReviews";
import { useHasPermission } from "@/hooks/useAuth";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/LoadingState";
import { SignalBadge } from "@/components/review/SignalBadge";
import { reviewReasonLabel } from "@/components/review/reviewReason";
import { useT } from "@/lib/i18n/I18nProvider";
import type { ReviewItemResponse } from "@/types/api";

const SHOWN = 5;

/** The oldest-first head of the Human Review queue, decidable right here (the full list, with shortcuts, is one click away). */
export function ReviewQueueCard() {
  const t = useT();
  const reviews = useReviewsList({ status: "open" });
  const canResolve = useHasPermission("reviews:resolve") === true;
  const rows = reviews.data?.pages[0]?.data.slice(0, SHOWN) ?? [];
  return (
    <Card className="flex h-full min-h-[300px] flex-col">
      <CardHeader
        title={t("overview.queueTitle")}
        action={
          <Link href="/review" className="text-xs text-accent hover:underline">
            {t("overview.queueOpenAll")}
          </Link>
        }
      />
      {reviews.isPending ? (
        <div className="space-y-2 p-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : reviews.isError ? (
        <ErrorState error={reviews.error} onRetry={() => reviews.refetch()} />
      ) : rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 text-center">
          <p className="text-sm font-medium text-foreground">{t("overview.queueEmptyTitle")}</p>
          <p className="mt-1 text-xs text-foreground-muted">{t("overview.queueEmptyNote")}</p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((item) => (
            <QueueRow key={item.id} item={item} canResolve={canResolve} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function QueueRow({ item, canResolve }: { item: ReviewItemResponse; canResolve: boolean }) {
  const t = useT();
  const resolve = useResolveReview(item.id);
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <Link href={`/review/${item.id}`} className="block truncate text-sm font-semibold text-foreground hover:text-accent">
          {item.emailPreview?.subject || t("review.noSubject")}
        </Link>
        <p className="truncate text-xs text-foreground-muted">
          {item.emailPreview?.fromAddress ?? "—"} · {reviewReasonLabel(item.reason, t)}
        </p>
      </div>
      <SignalBadge signal={item.signal} />
      {canResolve ? (
        <div className="flex shrink-0 gap-1.5">
          <Button variant="secondary" className="px-2.5 py-1 text-xs" disabled={resolve.isPending} onClick={() => resolve.mutate("spam")}>
            {t("overview.queueSpam")}
          </Button>
          <Button variant="primary" className="px-2.5 py-1 text-xs" disabled={resolve.isPending} onClick={() => resolve.mutate("approved")}>
            {t("overview.queueApprove")}
          </Button>
        </div>
      ) : null}
    </li>
  );
}
