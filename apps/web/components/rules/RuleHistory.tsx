"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useHasPermission } from "@/hooks/useAuth";
import { useRevertRule, useRuleVersions } from "@/hooks/useRules";
import { ApiRequestError } from "@/lib/api/client";
import { impactFromError, type RuleImpact, type RuleVersion } from "@/lib/api/rules";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { ConditionSummary } from "./ConditionSummary";
import { RuleImpactPanel, riskyDestinations } from "./RuleImpactPanel";

function differences(v: RuleVersion, current: RuleVersion | undefined): MessageKey[] {
  if (!current || v.id === current.id) return [];
  const out: MessageKey[] = [];
  if (v.name !== current.name) out.push("rules.historyFieldName");
  if (v.priority !== current.priority) out.push("rules.historyFieldPriority");
  if (v.destinationRef !== current.destinationRef) out.push("rules.historyFieldDestination");
  if (JSON.stringify(v.conditions) !== JSON.stringify(current.conditions)) out.push("rules.historyFieldConditions");
  return out;
}

/**
 * Phase 25: every version of this rule (one lineage, even across renames) and
 * going back to one. Going back saves the chosen content as a new version; a
 * deleted rule is restored the same way. The backend runs the rule impact
 * check first: a risky revert shows the impact and needs acknowledgement.
 */
export function RuleHistory({ ruleId }: { ruleId: string }) {
  const t = useT();
  const router = useRouter();
  const versions = useRuleVersions(ruleId);
  const revert = useRevertRule(ruleId);
  const canWrite = useHasPermission("rules:write") === true;
  const [open, setOpen] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<RuleVersion | null>(null);
  const [impact, setImpact] = useState<{ version: RuleVersion; impact: RuleImpact } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [priorityFor, setPriorityFor] = useState<{ version: RuleVersion; priority: string } | null>(null);

  if (versions.isPending) return null;
  if (versions.isError) {
    return <p className="text-sm text-status-danger-fg">{t("rules.historyLoadFailed")}</p>;
  }
  const rows = versions.data.data;
  const current = rows.find((v) => v.active);

  function run(version: RuleVersion, extra: { priority?: number; confirmImpact?: boolean } = {}) {
    revert.mutate(
      { version: version.version, ...extra },
      {
        onSuccess: (result) => {
          setConfirming(null);
          setImpact(null);
          setPriorityFor(null);
          router.push(`/rules/${result.rule.id}`);
        },
        onError: (error) => {
          setConfirming(null);
          const risky = impactFromError(error);
          if (risky) {
            setAcknowledged(false);
            setImpact({ version, impact: risky });
          } else if (error instanceof ApiRequestError && error.status === 409 && /priority/i.test(error.message)) {
            setPriorityFor({ version, priority: String(version.priority + 1) });
          }
        },
      },
    );
  }

  return (
    <Card>
      <CardHeader title={t("rules.historyTitle")} />
      <CardBody className="space-y-3">
        <p className="text-xs text-foreground-subtle">{t("rules.historyHelp")}</p>
        {!current ? <p className="text-xs text-status-warning-fg">{t("rules.historyDeletedNote")}</p> : null}
        <ul className="divide-y divide-border border border-border">
          {[...rows].reverse().map((v) => {
            const diff = differences(v, current);
            return (
              <li key={v.id} className="space-y-1.5 px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-foreground">{t("rules.historyVersion", { version: v.version })}</span>
                  {v.active ? (
                    <Badge tone="success" variant="pill">
                      {t("rules.historyCurrent")}
                    </Badge>
                  ) : null}
                  <span className="text-foreground">{v.name}</span>
                  <span className="text-foreground-subtle">
                    #{v.priority} → {v.destinationRef}
                  </span>
                  <span className="text-foreground-subtle">{formatDateTime(v.createdAt)}</span>
                  <span className="text-foreground-subtle">{t("rules.historyMatches", { count: v.matches })}</span>
                  <span className="ml-auto flex gap-2">
                    <button type="button" className="text-accent hover:underline" onClick={() => setOpen(open === v.version ? null : v.version)}>
                      {open === v.version ? t("rules.historyHideConditions") : t("rules.historyShowConditions")}
                    </button>
                    {canWrite && !v.active ? (
                      <Button variant="secondary" onClick={() => setConfirming(v)} loading={revert.isPending && revert.variables?.version === v.version}>
                        {current ? t("rules.historyGoBack") : t("rules.historyRestore")}
                      </Button>
                    ) : null}
                  </span>
                </div>
                {diff.length > 0 ? <p className="text-foreground-subtle">{t("rules.historyDiffers", { fields: diff.map((k) => t(k)).join(", ") })}</p> : null}
                {open === v.version ? (
                  <div className="border border-border bg-surface px-2 py-1.5">
                    <ConditionSummary condition={v.conditions} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>

        {revert.isError && !impact && !priorityFor ? (
          <p className="text-sm text-status-danger-fg" role="alert">
            {revert.error instanceof ApiRequestError ? revert.error.message : t("rules.historyFailed")}
          </p>
        ) : null}

        {priorityFor ? (
          <div className="flex flex-wrap items-end gap-2 border border-border p-3 text-sm">
            <label className="block">
              <span className="block text-xs text-foreground-muted">{t("rules.historyPriorityTaken")}</span>
              <input
                type="number"
                aria-label={t("rules.historyPriorityLabel")}
                value={priorityFor.priority}
                onChange={(e) => setPriorityFor({ ...priorityFor, priority: e.target.value })}
                className="mt-1 w-28 rounded-md border border-border-strong bg-surface-raised px-2 py-1.5 text-sm"
              />
            </label>
            <Button variant="primary" loading={revert.isPending} onClick={() => run(priorityFor.version, { priority: Number(priorityFor.priority) })}>
              {t("rules.historyTryAgain")}
            </Button>
          </div>
        ) : null}
      </CardBody>

      <ConfirmDialog
        open={confirming !== null}
        title={confirming ? t(current ? "rules.historyConfirmTitle" : "rules.historyRestoreTitle", { version: confirming.version }) : ""}
        description={confirming ? t(current ? "rules.historyConfirmDescription" : "rules.historyRestoreDescription", { version: confirming.version }) : ""}
        confirmLabel={current ? t("rules.historyGoBack") : t("rules.historyRestore")}
        confirmVariant="primary"
        loading={revert.isPending}
        onConfirm={() => confirming && run(confirming)}
        onCancel={() => setConfirming(null)}
      />

      <Modal open={impact !== null} onClose={() => setImpact(null)} title={t("rules.historyRiskyTitle")} className="max-w-2xl">
        {impact ? (
          <div className="space-y-3">
            <RuleImpactPanel impact={impact.impact} mode={current ? "update" : "create"} />
            {impact.impact.risky.count > 0 ? (
              <label className="flex items-start gap-2 text-sm text-foreground">
                <Checkbox checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-0.5" />
                <span>{t("rules.impactAcknowledge", { to: riskyDestinations(impact.impact, t) })}</span>
              </label>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setImpact(null)}>
                {t("common.cancel")}
              </Button>
              <Button variant="danger" disabled={impact.impact.risky.count > 0 && !acknowledged} loading={revert.isPending} onClick={() => run(impact.version, { confirmImpact: true })}>
                {t("rules.historyConfirmAnyway")}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </Card>
  );
}
