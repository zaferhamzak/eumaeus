"use client";

import { use } from "react";
import Link from "next/link";
import { useRuleGraph, useSetRuleGraphEnabled, useUpdateRuleGraph } from "@/hooks/useRuleGraphs";
import { useMailboxesList, useSetMailboxRuleGraph } from "@/hooks/useMailboxes";
import { useHasPermission } from "@/hooks/useAuth";
import { RuleGraphEditor } from "@/components/ruleGraphs/RuleGraphEditor";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { LoadingState } from "@/components/ui/LoadingState";
import { ErrorState } from "@/components/ui/ErrorState";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/I18nProvider";

/** Which of this organization's mailboxes this graph routes. Assigning here REPLACES that mailbox's previous graph (a mailbox has at most one). Needs mailboxes:write, since it changes how that mailbox's mail is routed. */
function MailboxAssignment({ graphId }: { graphId: string }) {
  const t = useT();
  const mailboxes = useMailboxesList();
  const assign = useSetMailboxRuleGraph();
  const canAssign = useHasPermission("mailboxes:write") === true;
  const rows = mailboxes.data?.data ?? [];

  if (mailboxes.isPending) return <LoadingState label={t("ruleGraphs.loadingMailboxes")} />;
  if (rows.length === 0) return <p className="text-sm text-foreground-subtle">{t("ruleGraphs.noMailboxes")}</p>;

  return (
    <ul className="divide-y divide-border border border-border">
      {rows.map((m) => {
        const assignedHere = m.ruleGraphId === graphId;
        const assignedElsewhere = m.ruleGraphId !== null && !assignedHere;
        return (
          <li key={m.id} className="flex items-center gap-3 px-3 py-2">
            <Checkbox
              checked={assignedHere}
              disabled={!canAssign || (assign.isPending && assign.variables?.id === m.id)}
              onChange={(e) => assign.mutate({ id: m.id, ruleGraphId: e.target.checked ? graphId : null })}
              aria-label={t("ruleGraphs.routeMailboxAria", { address: m.emailAddress })}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">{m.name || m.emailAddress}</p>
              <p className="truncate font-mono text-[10.5px] text-foreground-subtle">{m.emailAddress}</p>
            </div>
            {assignedElsewhere ? <span className="text-[10.5px] text-foreground-subtle">{t("ruleGraphs.usesAnotherGraph")}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

export default function RuleGraphDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const t = useT();
  const { id } = use(params);
  const graph = useRuleGraph(id);
  const update = useUpdateRuleGraph(id);
  const setEnabled = useSetRuleGraphEnabled(id);
  const canWrite = useHasPermission("rule_graphs:write") === true;

  if (graph.isPending) return <LoadingState label={t("ruleGraphs.loading")} />;
  if (graph.isError) return <ErrorState error={graph.error} onRetry={() => graph.refetch()} />;
  const g = graph.data;

  return (
    <div className="space-y-4">
      <Link href="/rule-graphs" className="text-xs text-foreground-muted hover:text-accent hover:underline">
        {t("ruleGraphs.backToGraphs")}
      </Link>

      <header className="flex flex-wrap items-center justify-between gap-3 border border-border bg-surface-raised p-3 rounded-lg">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold text-foreground">{g.name}</h1>
            <Badge tone={g.enabled ? "success" : "neutral"} variant="dot">
              {g.enabled ? t("ruleGraphs.enabledLive") : t("ruleGraphs.disabledFlat")}
            </Badge>
          </div>
          <p className="text-xs text-foreground-subtle">
            {t("ruleGraphs.versionSaved", { version: g.version, time: formatDateTime(g.versionCreatedAt) })}
          </p>
        </div>
        {canWrite ? (
          <Button variant={g.enabled ? "danger" : "primary"} loading={setEnabled.isPending} onClick={() => setEnabled.mutate(!g.enabled)}>
            {g.enabled ? t("ruleGraphs.disable") : t("ruleGraphs.enable")}
          </Button>
        ) : null}
      </header>

      <Card>
        <CardHeader title={t("ruleGraphs.mailboxesCardTitle")} />
        <CardBody>
          <MailboxAssignment graphId={g.id} />
        </CardBody>
      </Card>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-foreground">{t("ruleGraphs.steps")}</h2>
        {canWrite ? (
          <RuleGraphEditor
            key={g.version}
            initial={{ name: g.name, rootNodeKey: g.rootNodeKey, nodes: g.nodes.map(({ key, conditions, onTrue, onFalse }) => ({ key, conditions, onTrue, onFalse })) }}
            submitLabel={t("ruleGraphs.saveAsNewVersion")}
            submitting={update.isPending}
            error={update.error}
            onSubmit={(input) => update.mutate(input)}
          />
        ) : (
          <pre className="overflow-x-auto border border-border bg-surface p-3 text-[11px]">{JSON.stringify(g.nodes, null, 2)}</pre>
        )}
      </div>
    </div>
  );
}
