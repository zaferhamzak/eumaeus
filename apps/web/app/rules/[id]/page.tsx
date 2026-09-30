"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useRule, useUpdateRule, useDeactivateRule } from "@/hooks/useRules";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { Icon } from "@/components/ui/Icon";
import { RuleForm } from "@/components/rules/RuleForm";
import { ConditionSummary } from "@/components/rules/ConditionSummary";
import { RuleHistory } from "@/components/rules/RuleHistory";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/I18nProvider";
import { useHasPermission } from "@/hooks/useAuth";
import { ApiRequestError } from "@/lib/api/client";
import { impactFromError, type RuleImpact } from "@/lib/api/rules";
import { RuleDeleteImpactDialog } from "@/components/rules/RuleImpactPanel";

export default function RuleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const t = useT();
  const { id } = use(params);
  const router = useRouter();
  const rule = useRule(id);
  const update = useUpdateRule(id);
  const deactivate = useDeactivateRule();
  const [editing, setEditing] = useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [deleteImpact, setDeleteImpact] = useState<RuleImpact | null>(null);
  const canDelete = useHasPermission("rules:delete") === true;

  if (rule.isPending) return <LoadingState label={t("rules.loadingRule")} />;
  if (rule.isError) return <ErrorState error={rule.error} onRetry={() => rule.refetch()} />;

  const r = rule.data;
  const tone = r.enabled ? "success" : "neutral";

  return (
    <div className="space-y-4">
      <Link href="/rules" className="text-xs text-foreground-muted hover:text-accent hover:underline">
        {t("rules.backToRules")}
      </Link>

      {/* Decision-block header — same visual pattern as the Email inspector's header (icon chip + headline + a right-aligned real stat), real fields only: enabled state, destination, and priority (there is no "risk"/"confidence" figure for a rule, so priority — the real ordering value — takes that slot). */}
      <div className="grid grid-cols-[34px_1fr_auto] items-center gap-3 border border-border bg-surface-raised p-3 rounded-lg">
        <div
          className="grid h-[34px] w-[34px] place-items-center border"
          style={{
            color: `var(--status-${tone}-fg)`,
            background: `var(--status-${tone}-bg)`,
            borderColor: `color-mix(in srgb, var(--status-${tone}-fg) 35%, transparent)`,
          }}
        >
          <Icon name="rules" size={17} />
        </div>
        <div className="min-w-0">
          <span className="text-[8px] font-semibold tracking-wide text-foreground-subtle uppercase">{r.enabled ? t("rules.enabledRule") : t("rules.disabledRule")}</span>
          <h1 className="truncate text-base font-semibold text-foreground">
            {r.name} <span className="text-xs font-normal text-foreground-subtle">v{r.version}</span>
          </h1>
          <p className="truncate text-xs text-foreground-subtle">
            → <span className="text-foreground-muted">{r.destinationRef}</span>
          </p>
        </div>
        <div className="text-right">
          <span className="block font-mono text-base text-foreground">{r.priority}</span>
          <span className="block text-[8px] text-foreground-subtle">{t("rules.priorityCaps")}</span>
        </div>
      </div>

      <Card>
        <CardHeader
          title={editing ? t("rules.editRule") : t("rules.details")}
          action={
            r.enabled && !editing ? (
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setEditing(true)}>
                  {t("rules.edit")}
                </Button>
                {canDelete ? (
                  <Button variant="danger" onClick={() => setConfirmDeactivate(true)}>
                    {t("rules.deactivate")}
                  </Button>
                ) : null}
              </div>
            ) : null
          }
        />
        <CardBody className="space-y-4">
          {!editing ? (
            <>
              <div>
                <p className="mb-1.5 text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{t("rules.conditions")}</p>
                <div className="border border-border bg-surface px-3 py-2">
                  <ConditionSummary condition={r.conditions} />
                </div>
              </div>
              <p className="text-xs text-foreground-subtle">
                {t("rules.createdUpdated", { created: formatDateTime(r.createdAt), updated: formatDateTime(r.updatedAt) })}
                {r.deactivatedAt ? t("rules.deactivatedAt", { time: formatDateTime(r.deactivatedAt) }) : ""}
              </p>
              {!r.enabled ? (
                <div>
                  <Badge tone="neutral">{t("rules.deactivatedBadge")}</Badge>
                </div>
              ) : null}
            </>
          ) : (
            <RuleForm
              initial={{ name: r.name, priority: r.priority, destinationRef: r.destinationRef, conditions: r.conditions }}
              submitLabel={t("rules.saveAsNewVersion")}
              replaceRuleId={r.id}
              isSubmitting={update.isPending}
              submitError={update.error}
              versioningNotice={t("rules.versioningNotice", { next: r.version + 1, current: r.version })}
              onSubmit={(input, options) => update.mutate({ input, ...options }, { onSuccess: (newRule) => router.push(`/rules/${newRule.id}`) })}
            />
          )}
        </CardBody>
      </Card>

      {deactivate.isError && !impactFromError(deactivate.error) ? (
        <p className="text-sm text-status-danger-fg" role="alert">
          {deactivate.error instanceof ApiRequestError ? deactivate.error.message : t("rules.deleteFailed")}
        </p>
      ) : null}

      <RuleHistory ruleId={r.id} />

      <ConfirmDialog
        open={confirmDeactivate}
        title={t("rules.deactivateConfirmTitle")}
        description={t("rules.deactivateConfirmDescription", { name: r.name })}
        confirmLabel={t("rules.deactivate")}
        loading={deactivate.isPending}
        onConfirm={() =>
          deactivate.mutate(
            { id },
            {
              onSuccess: () => {
                setConfirmDeactivate(false);
                router.push("/rules");
              },
              onError: (error) => {
                setConfirmDeactivate(false);
                // 409: deleting would move business mail — show what and ask again.
                setDeleteImpact(impactFromError(error));
              },
            },
          )
        }
        onCancel={() => setConfirmDeactivate(false)}
      />

      <RuleDeleteImpactDialog
        impact={deleteImpact}
        loading={deactivate.isPending}
        onConfirm={() =>
          deactivate.mutate(
            { id, confirmImpact: true },
            {
              onSuccess: () => {
                setDeleteImpact(null);
                router.push("/rules");
              },
              onError: () => setDeleteImpact(null),
            },
          )
        }
        onCancel={() => setDeleteImpact(null)}
      />
    </div>
  );
}
