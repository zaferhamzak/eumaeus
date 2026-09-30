"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useDeactivateRule, useRulesList } from "@/hooks/useRules";
import { useDestinationsList } from "@/hooks/useDestinations";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ApiRequestError } from "@/lib/api/client";
import { impactFromError, type RuleImpact } from "@/lib/api/rules";
import { RuleDeleteImpactDialog } from "@/components/rules/RuleImpactPanel";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table";
import { formatRelativeTime } from "@/lib/format";
import type { RuleResponse } from "@/types/api";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { TableSkeleton } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/Button";
import { Pagination } from "@/components/ui/Pagination";
import { ConditionSummary } from "@/components/rules/ConditionSummary";
import { useHasPermission } from "@/hooks/useAuth";
import { RuleImportExport } from "@/components/rules/RuleImportExport";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";

export default function RulesPage() {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <RulesPageContent />
    </Suspense>
  );
}

function RulesPageContent() {
  const t = useT();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Default: active rules only. Deleted rules and old versions (an edit
  // deactivates the previous version) are one click away, not in the way.
  const stateParam = searchParams.get("enabled");
  const view: "true" | "false" | "all" = stateParam === "false" || stateParam === "all" ? stateParam : "true";
  const enabled = view === "all" ? undefined : view;

  const rules = useRulesList({ enabled });
  // 1.2 (O): which destinations also email people when a rule sends mail there.
  const destinations = useDestinationsList();
  const notifying = new Set(
    (destinations.data?.data ?? [])
      .filter((d) => d.channels.some((c) => c.type === "email_notify" && c.enabled && !c.deactivatedAt))
      .map((d) => d.name),
  );
  const deactivate = useDeactivateRule();
  const [toDelete, setToDelete] = useState<RuleResponse | null>(null);
  // A delete refused with 409: the rule and what deleting it would move.
  const [deleteImpact, setDeleteImpact] = useState<{ rule: RuleResponse; impact: RuleImpact } | null>(null);
  const rows = (rules.data?.pages.flatMap((p) => p.data) ?? []).sort(
    (a, b) => a.priority - b.priority,
  );
  const lastPage = rules.data?.pages[rules.data.pages.length - 1];
  const canWrite = useHasPermission("rules:write");
  const canDelete = useHasPermission("rules:delete");

  function setEnabledFilter(value: "true" | "false" | "all") {
    const next = new URLSearchParams(searchParams.toString());
    if (value !== "true") next.set("enabled", value);
    else next.delete("enabled");
    router.push(`/rules?${next.toString()}`);
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-foreground">{t("rules.title")}</h1>
          <p className="text-sm text-foreground-muted">
            {t("rules.subtitle")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RuleImportExport
            canWrite={canWrite === true}
            canDelete={canDelete === true}
          />
          {canWrite ? (
            <Link href="/rules/new">
              <Button variant="primary">{t("rules.newRule")}</Button>
            </Link>
          ) : null}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-1.5 border border-border bg-surface-raised px-2 py-1.5 rounded-lg">
        <div
          className="flex flex-wrap items-center gap-1"
          role="group"
          aria-label={t("rules.filterByState")}
        >
          {(
            [
              ["true", "rules.filterActive"],
              ["false", "rules.filterInactive"],
              ["all", "rules.filterEverything"],
            ] as const satisfies ReadonlyArray<readonly ["true" | "false" | "all", MessageKey]>
          ).map(([value, label]) => (
            <button
              key={label}
              type="button"
              onClick={() => setEnabledFilter(value)}
              aria-pressed={view === value}
              className={`h-7 px-2 text-[11px] font-medium rounded-md ${
                view === value
                  ? "border border-accent bg-accent-soft text-accent"
                  : "border border-border bg-surface text-foreground-muted hover:text-foreground"
              }`}
            >
              {t(label)}
            </button>
          ))}
        </div>
        <span className="ml-auto font-mono text-[10px] text-foreground-subtle">
          {t("rules.loadedCount", { count: rows.length })}
        </span>
      </div>

      <div className="overflow-hidden border border-border bg-surface-raised rounded-lg">
        {rules.isPending ? (
          <TableSkeleton />
        ) : rules.isError ? (
          <ErrorState error={rules.error} onRetry={() => rules.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={
              view !== "all"
                ? t(view === "true" ? "rules.emptyEnabled" : "rules.emptyDisabled")
                : t("rules.emptyTitle")
            }
            description={t("rules.emptyDescription")}
            action={
              canWrite ? (
                <Link href="/rules/new">
                  <Button variant="secondary">{t("rules.newRule")}</Button>
                </Link>
              ) : undefined
            }
          />
        ) : (
          <>
            <Table>
              <Thead>
                <Tr className="hover:bg-transparent">
                  <Th className="w-[64px] text-[10px]">{t("rules.colPriority")}</Th>
                  <Th className="text-[10px]">{t("rules.colNameConditions")}</Th>
                  <Th className="w-[160px] text-[10px]">{t("rules.colDestination")}</Th>
                  <Th className="w-[150px] text-[10px]">{t("rules.colMatches")}</Th>
                  <Th className="w-[100px] text-[10px]">{t("rules.colState")}</Th>
                  {canDelete ? <Th className="w-[10px]" /> : null}
                  <Th className="w-[10px]" aria-label={t("rules.colOpen")} />
                </Tr>
              </Thead>
              <Tbody>
                {rows.map((rule) => (
                  <Tr key={rule.id} className="group cursor-pointer">
                    <Td className="font-mono text-[10.5px] text-foreground-muted">
                      {rule.priority}
                    </Td>
                    <Td className="max-w-0">
                      <Link
                        href={`/rules/${rule.id}`}
                        className="block truncate text-sm font-medium text-foreground group-hover:text-accent group-hover:underline"
                      >
                        {rule.name}
                        <span className="ml-1.5 text-xs font-normal text-foreground-subtle">
                          v{rule.version}
                        </span>
                      </Link>
                      <div className="truncate">
                        <ConditionSummary condition={rule.conditions} />
                      </div>
                    </Td>
                    <Td className="truncate font-mono text-[10.5px] text-foreground-muted">
                      {rule.destinationRef}
                      {rule.destinationRef && notifying.has(rule.destinationRef) ? (
                        <span title={t("rules.notifiesHint")} className="ml-1.5 inline-block rounded bg-accent-soft px-1 py-px font-sans text-[10px] font-medium text-accent">
                          {t("rules.notifies")}
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      <RuleStatsCell rule={rule} />
                    </Td>
                    <Td>
                      <Badge
                        tone={rule.enabled ? "success" : "neutral"}
                        variant="dot"
                      >
                        {rule.enabled ? t("rules.enabled") : t("rules.disabled")}
                      </Badge>
                    </Td>
                    {canDelete ? (
                      <Td>
                        {rule.enabled ? (
                          <button
                            type="button"
                            onClick={() => setToDelete(rule)}
                            aria-label={t("rules.deleteRuleAria", { name: rule.name })}
                            title={t("rules.deactivate")}
                            className="text-foreground-subtle hover:text-status-danger-fg"
                          >
                            ✕
                          </button>
                        ) : null}
                      </Td>
                    ) : null}
                    <Td>
                      <Link
                        href={`/rules/${rule.id}`}
                        aria-label={t("rules.openRule", { name: rule.name })}
                        className="text-foreground-subtle group-hover:text-accent"
                      >
                        →
                      </Link>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
            <Pagination
              hasMore={Boolean(lastPage?.pagination.hasMore)}
              loading={rules.isFetchingNextPage}
              onLoadMore={() => rules.fetchNextPage()}
            />
          </>
        )}
      </div>

      {deactivate.isError && !impactFromError(deactivate.error) ? (
        <p className="text-sm text-status-danger-fg" role="alert">
          {deactivate.error instanceof ApiRequestError ? deactivate.error.message : t("rules.deleteFailed")}
        </p>
      ) : null}
      <ConfirmDialog
        open={toDelete !== null}
        title={t("rules.deactivateConfirmTitle")}
        description={t("rules.deactivateConfirmDescription", { name: toDelete?.name ?? "" })}
        confirmLabel={t("rules.deactivate")}
        loading={deactivate.isPending}
        onConfirm={() => {
          if (!toDelete) return;
          const rule = toDelete;
          deactivate.mutate(
            { id: rule.id },
            {
              onSettled: () => setToDelete(null),
              onError: (error) => {
                const impact = impactFromError(error);
                if (impact) setDeleteImpact({ rule, impact });
              },
            },
          );
        }}
        onCancel={() => setToDelete(null)}
      />
      <RuleDeleteImpactDialog
        impact={deleteImpact?.impact ?? null}
        loading={deactivate.isPending}
        onConfirm={() => deleteImpact && deactivate.mutate({ id: deleteImpact.rule.id, confirmImpact: true }, { onSettled: () => setDeleteImpact(null) })}
        onCancel={() => setDeleteImpact(null)}
      />
    </div>
  );
}

/**
 * Counted since this version was saved (an edit starts a new version). A
 * live rule that emails have reached but that never matched is flagged: it's
 * either dead weight or its conditions are wrong.
 */
function RuleStatsCell({ rule }: { rule: RuleResponse }) {
  const t = useT();
  const stats = rule.stats;
  if (!stats) return <span className="text-xs text-foreground-subtle">—</span>;
  if (stats.matchesLast30Days === 0) {
    if (!rule.enabled)
      return (
        <span className="font-mono text-[10.5px] text-foreground-subtle">
          0
        </span>
      );
    const reached = stats.evaluationsLast30Days > 0;
    return (
      <span
        title={
          reached
            ? t("rules.statsCheckedNoMatch", { count: stats.evaluationsLast30Days })
            : t("rules.statsNotReachedHint")
        }
      >
        <Badge tone={reached ? "warning" : "neutral"} variant="dot">
          {reached ? t("rules.statsNoMatches") : t("rules.statsNotReached")}
        </Badge>
      </span>
    );
  }
  return (
    <span className="block leading-tight">
      <span className="font-mono text-[11px] text-foreground tabular-nums">
        {stats.matchesLast30Days}
      </span>
      <span className="ml-1 text-[10px] text-foreground-subtle">
        {t("rules.statsThisWeek", { count: stats.matchesLast7Days })}
      </span>
      {stats.lastMatchedAt ? (
        <span className="block text-[10px] text-foreground-subtle">
          {t("rules.statsLastMatched", { time: formatRelativeTime(stats.lastMatchedAt) })}
        </span>
      ) : null}
    </span>
  );
}
