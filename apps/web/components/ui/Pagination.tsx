"use client";

import { Button } from "./Button";
import { useT } from "@/lib/i18n/I18nProvider";

/**
 * Cursor pagination only (§5/§29: "do not implement client-side pagination
 * over an unbounded dataset... use the backend cursor API"). There is no
 * "page number" concept anywhere in this component or its callers — a
 * cursor-paginated list can only ever go "forward" (fetch the next page) or
 * be reset to the first page; there is no backend support for jumping to an
 * arbitrary page or going "back" to a specific prior cursor, so this
 * component doesn't pretend to offer either.
 */
export function Pagination({
  hasMore,
  loading,
  onLoadMore,
}: {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  const t = useT();
  if (!hasMore) {
    return <p className="px-4 py-3 text-center text-xs text-foreground-subtle">{t("common.endOfResults")}</p>;
  }
  return (
    <div className="flex justify-center border-t border-border px-4 py-3">
      <Button variant="secondary" onClick={onLoadMore} loading={loading}>
        {t("common.loadMore")}
      </Button>
    </div>
  );
}
