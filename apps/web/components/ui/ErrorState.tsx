"use client";

import { ApiRequestError } from "@/lib/api/client";
import { Button } from "./Button";
import { useT } from "@/lib/i18n/I18nProvider";

/**
 * §37: "An error is not an empty state" — every page that lists/loads data
 * must render THIS, distinctly from EmptyState, whenever the fetch itself
 * failed (react-query's `isError`), never just fall through to rendering an
 * empty table. Shows the request id when the backend supplied one (§24) —
 * never a stack trace, SQL fragment, or other internal detail, because
 * ApiRequestError's `message` is already the backend's own safe, human
 * message (see lib/api/client.ts).
 */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useT();
  const message = error instanceof ApiRequestError ? error.message : t("common.errorFallback");
  const requestId = error instanceof ApiRequestError ? error.requestId : null;

  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center" role="alert">
      <p className="text-sm font-medium text-status-danger-fg">{t("common.errorTitle")}</p>
      <p className="max-w-md text-sm text-foreground-muted">{message}</p>
      {requestId ? <p className="font-mono text-xs text-foreground-subtle">{t("common.requestId", { id: requestId })}</p> : null}
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      ) : null}
    </div>
  );
}
