"use client";

import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n/I18nProvider";

/** A skeleton block, not a full-page spinner (§38: "avoid full-page spinners whenever only one panel is loading"). Callers place this inside just the panel/section that's loading. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-status-neutral-bg", className)} aria-hidden="true" />;
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  const t = useT();
  return (
    <div className="space-y-2 p-4" aria-busy="true" aria-live="polite">
      <span className="sr-only">{t("common.loading")}</span>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

export function LoadingState({ label }: { label?: string }) {
  const t = useT();
  return (
    <div className="flex items-center justify-center px-6 py-16 text-sm text-foreground-muted" role="status" aria-live="polite">
      {label ?? t("common.loading")}
    </div>
  );
}
