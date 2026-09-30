"use client";

import { useSuggestionMutations, useSuggestions } from "@/hooks/useSenderLists";
import { useHasPermission } from "@/hooks/useAuth";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ApiRequestError } from "@/lib/api/client";
import { useT } from "@/lib/i18n/I18nProvider";

/**
 * Proposals drawn from Human Review decisions (Phase 16): a sender whose
 * emails were resolved the same way at least 5 times, 90% of the time.
 * Nothing changes until someone accepts. Hidden entirely when there's
 * nothing to suggest, so it never takes space on a busy page.
 */
export function SuggestionsPanel({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const suggestions = useSuggestions();
  const { refresh, decide } = useSuggestionMutations();
  const canWrite = useHasPermission("rules:write") === true;
  const rows = suggestions.data?.data ?? [];

  if (suggestions.isError || (compact && rows.length === 0)) return null;

  return (
    <section className="space-y-3 border border-border bg-surface-raised p-4 rounded-lg" aria-labelledby="suggestions-title">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="suggestions-title" className="text-sm font-semibold text-foreground">
            {t("senderLists.suggestionsTitle")}
          </h2>
          <p className="text-xs text-foreground-subtle">{t("senderLists.suggestionsDescription")}</p>
        </div>
        <Button variant="ghost" loading={refresh.isPending} onClick={() => refresh.mutate()}>
          {t("senderLists.checkAgain")}
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-foreground-muted">
          {t("senderLists.suggestionsEmpty")}
        </p>
      ) : (
        <ul className="divide-y divide-border border border-border">
          {rows.map((s) => {
            const agreeing = s.kind === "block" ? s.spamCount : s.approvedCount;
            return (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-sm">
                <Badge tone={s.kind === "block" ? "danger" : "success"} variant="pill">
                  {s.kind === "block" ? t("senderLists.suggestionBlock") : t("senderLists.suggestionAllow")}
                </Badge>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-foreground">{s.pattern}</span>
                  <span className="block text-xs text-foreground-subtle">
                    {t(s.kind === "block" ? "senderLists.suggestionStatsSpam" : "senderLists.suggestionStatsApproved", { agreeing, total: s.resolvedCount })}
                    {s.pattern.startsWith("@") ? t("senderLists.coversDomain") : ""}
                  </span>
                </span>
                {canWrite ? (
                  <span className="flex gap-2">
                    <Button variant="ghost" onClick={() => decide.mutate({ id: s.id, action: "dismiss" })} disabled={decide.isPending}>
                      {t("senderLists.dismiss")}
                    </Button>
                    <Button variant="primary" onClick={() => decide.mutate({ id: s.id, action: "accept" })} loading={decide.isPending && decide.variables?.id === s.id && decide.variables.action === "accept"}>
                      {s.kind === "block" ? t("senderLists.blockSender") : t("senderLists.allowSender")}
                    </Button>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {decide.isError ? (
        <p className="text-xs text-status-danger-fg" role="alert">
          {decide.error instanceof ApiRequestError ? decide.error.message : t("senderLists.suggestionUpdateFailed")}
        </p>
      ) : null}
      {rows.length > 0 ? <p className="text-[11px] text-foreground-subtle">{t("senderLists.dismissedNote")}</p> : null}
    </section>
  );
}
