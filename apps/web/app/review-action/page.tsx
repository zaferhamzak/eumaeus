"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useConfirmReviewAction, useReviewActionPreview } from "@/hooks/useReviews";
import type { ReviewActionPreview } from "@/lib/api/review";
import { Button } from "@/components/ui/Button";
import { ApiRequestError } from "@/lib/api/client";
import { Logo } from "@/components/brand/Logo";
import { useT } from "@/lib/i18n/I18nProvider";

function EmailSummary({ preview }: { preview: ReviewActionPreview }) {
  const t = useT();
  return (
    <div className="space-y-1 border border-border bg-surface px-3 py-2">
      <p className="text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{preview.organizationName}</p>
      <p className="text-sm font-medium break-words text-foreground">{preview.subject || t("review.noSubject")}</p>
      <p className="text-xs break-all text-foreground-muted">{t("review.from", { address: preview.fromAddress })}</p>
    </div>
  );
}

/**
 * Opened from a one-click link in the Human Review digest email. Public (the
 * signed token is the credential), and deciding always takes an explicit
 * click: mail scanners and link previews fetch URLs on their own, so loading
 * this page only previews.
 */
function ReviewActionContent() {
  const t = useT();
  const token = useSearchParams().get("token") ?? "";
  const preview = useReviewActionPreview(token);
  const confirm = useConfirmReviewAction();

  const errorMessage = (error: unknown) => (error instanceof ApiRequestError ? error.message : t("review.actionFailed"));

  let body: React.ReactNode;
  if (!token) {
    body = <p className="text-sm text-status-danger-fg">{t("review.actionMissingToken")}</p>;
  } else if (preview.isPending) {
    body = <p className="text-sm text-foreground-muted">{t("review.actionLoading")}</p>;
  } else if (preview.isError) {
    body = (
      <p className="text-sm text-status-danger-fg" role="alert">
        {errorMessage(preview.error)}
      </p>
    );
  } else if (confirm.isSuccess) {
    const result = confirm.data;
    const message = result.resolved
      ? result.resolution === "spam"
        ? t("review.actionDoneSpam")
        : t("review.actionDoneApproved")
      : result.status === "superseded"
        ? t("review.actionClosedByReprocessing")
        : t("review.actionAlreadyDecided");
    body = (
      <div className="space-y-3">
        <EmailSummary preview={result} />
        <p className={`text-sm font-medium ${result.resolved ? "text-status-success-fg" : "text-foreground"}`} role="status">
          {message}
        </p>
        <Link href="/review" className="text-xs text-accent hover:underline">
          {t("review.actionOpenHumanReview")}
        </Link>
      </div>
    );
  } else {
    const p = preview.data;
    const isSpam = p.resolution === "spam";
    body = (
      <div className="space-y-4">
        <EmailSummary preview={p} />
        {p.alreadyClosed ? (
          <>
            <p className="text-sm text-foreground" role="status">
              {p.status === "superseded" ? t("review.actionClosedByReprocessing") : t("review.actionAlreadyDecided")}
            </p>
            <Link href="/review" className="text-xs text-accent hover:underline">
              {t("review.actionOpenHumanReview")}
            </Link>
          </>
        ) : (
          <>
            <p className="text-sm text-foreground-muted">{isSpam ? t("review.actionIntroSpam") : t("review.actionIntroApproved")}</p>
            {confirm.isError ? (
              <p className="text-sm text-status-danger-fg" role="alert">
                {errorMessage(confirm.error)}
              </p>
            ) : null}
            <Button variant={isSpam ? "danger" : "primary"} loading={confirm.isPending} onClick={() => confirm.mutate(token)}>
              {isSpam ? t("review.actionConfirmSpam") : t("review.actionConfirmApproved")}
            </Button>
            <p className="text-[11px] text-foreground-subtle">{t("review.actionNoAutoDecide")}</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-5 border border-border bg-surface-raised p-6 rounded-lg">
        <div className="flex items-center gap-2.5">
          <Logo size={24} className="text-foreground" />
          <span className="text-base font-semibold text-foreground">Eumaeus</span>
        </div>
        <h1 className="text-sm font-semibold text-foreground">{t("review.actionTitle")}</h1>
        {body}
      </div>
    </div>
  );
}

export default function ReviewActionPage() {
  return (
    <Suspense>
      <ReviewActionContent />
    </Suspense>
  );
}
