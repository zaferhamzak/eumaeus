"use client";

import Link from "next/link";
import { useRuleGraphsList } from "@/hooks/useRuleGraphs";
import { useMailboxesList } from "@/hooks/useMailboxes";
import { useHasPermission } from "@/hooks/useAuth";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { TableSkeleton } from "@/components/ui/LoadingState";
import { formatRelativeTime } from "@/lib/format";
import { useT } from "@/lib/i18n/I18nProvider";

export default function RuleGraphsPage() {
  const t = useT();
  const graphs = useRuleGraphsList();
  const mailboxes = useMailboxesList();
  const canWrite = useHasPermission("rule_graphs:write");
  const rows = graphs.data?.data ?? [];

  const assignedCount = (graphId: string) => (mailboxes.data?.data ?? []).filter((m) => m.ruleGraphId === graphId).length;

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-foreground">{t("ruleGraphs.title")}</h1>
          <p className="text-sm text-foreground-muted">
            {t("ruleGraphs.subtitle")}
          </p>
        </div>
        {canWrite ? (
          <Link href="/rule-graphs/new">
            <Button variant="primary">{t("ruleGraphs.newGraph")}</Button>
          </Link>
        ) : null}
      </header>

      <div className="overflow-hidden border border-border bg-surface-raised rounded-lg">
        {graphs.isPending ? (
          <TableSkeleton />
        ) : graphs.isError ? (
          <ErrorState error={graphs.error} onRetry={() => graphs.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title={t("ruleGraphs.emptyTitle")} description={t("ruleGraphs.emptyDescription")} />
        ) : (
          <Table>
            <Thead>
              <Tr className="hover:bg-transparent">
                <Th className="text-[10px]">{t("ruleGraphs.colName")}</Th>
                <Th className="w-[110px] text-[10px]">{t("ruleGraphs.colState")}</Th>
                <Th className="w-[140px] text-[10px]">{t("ruleGraphs.colUsedBy")}</Th>
                <Th className="w-[110px] text-[10px]">{t("ruleGraphs.colUpdated")}</Th>
              </Tr>
            </Thead>
            <Tbody>
              {rows.map((g) => (
                <Tr key={g.id} className="group">
                  <Td>
                    <Link href={`/rule-graphs/${g.id}`} className="text-sm font-medium text-foreground group-hover:text-accent group-hover:underline">
                      {g.name}
                    </Link>
                  </Td>
                  <Td>
                    <Badge tone={g.enabled ? "success" : "neutral"} variant="dot">
                      {g.enabled ? t("ruleGraphs.enabled") : t("ruleGraphs.disabled")}
                    </Badge>
                  </Td>
                  <Td className="text-xs text-foreground-muted">{t("ruleGraphs.usedByMailboxes", { n: assignedCount(g.id) })}</Td>
                  <Td className="font-mono text-[10.5px] text-foreground-muted">{formatRelativeTime(g.updatedAt)}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </div>
    </div>
  );
}
