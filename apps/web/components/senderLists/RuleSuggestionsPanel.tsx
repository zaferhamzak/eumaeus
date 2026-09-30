"use client";

import { useState } from "react";
import Link from "next/link";
import { useRuleSuggestionMutations, useRuleSuggestions } from "@/hooks/useSenderLists";
import { useDestinationsList } from "@/hooks/useDestinations";
import { useHasPermission } from "@/hooks/useAuth";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ConditionSummary } from "@/components/rules/ConditionSummary";
import { RuleImpactPanel, riskyDestinations } from "@/components/rules/RuleImpactPanel";
import { ApiRequestError } from "@/lib/api/client";
import { impactFromError } from "@/lib/api/rules";
import type { RuleSuggestion } from "@/lib/api/senderLists";
import { useT } from "@/lib/i18n/I18nProvider";

const labelClass = "mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase";
const inputClass = "w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm";

interface CreatedRule {
  suggestionId: string;
  ruleId: string;
  name: string;
}

function RuleSuggestionRow({ suggestion: s, canWrite, onCreated }: { suggestion: RuleSuggestion; canWrite: boolean; onCreated: (rule: CreatedRule) => void }) {
  const t = useT();
  const { accept, dismiss } = useRuleSuggestionMutations();
  const needsDestination = s.draft.destinationRef === null;
  const destinations = useDestinationsList();
  const [destination, setDestination] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);

  const impact = impactFromError(accept.error);
  const needsAck = (impact?.risky.count ?? 0) > 0;
  const agreeing = s.decision === "spam" ? s.spamCount : s.approvedCount;
  const destinationLabel = (ref: string) => (ref === "human_review" ? t("senderLists.humanReview") : ref);

  const submit = (confirmImpact: boolean) => {
    accept.mutate(
      { id: s.id, input: { ...(needsDestination ? { destinationRef: destination } : {}), ...(confirmImpact ? { confirmImpact: true } : {}) } },
      { onSuccess: (res) => onCreated({ suggestionId: s.id, ruleId: res.ruleId, name: res.draft?.name ?? s.draft.name }) },
    );
  };

  return (
    <li className="space-y-2 px-3 py-3 text-sm">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <Badge tone={s.decision === "spam" ? "danger" : "success"} variant="pill">
          {s.decision === "spam" ? t("senderLists.ruleSuggestionSpam") : t("senderLists.ruleSuggestionApproved")}
        </Badge>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-foreground">
            <span className="font-mono">{s.sender}</span>
            <span className="text-foreground-muted"> · {t("senderLists.ruleSuggestionSubject", { word: s.word })}</span>
          </span>
          <span className="block text-xs text-foreground-subtle">
            {t(s.decision === "spam" ? "senderLists.ruleSuggestionStatsSpam" : "senderLists.ruleSuggestionStatsApproved", { agreeing, total: s.resolvedCount })}
          </span>
        </span>
      </div>

      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
        <dt className="text-foreground-subtle">{t("senderLists.ruleSuggestionConditions")}</dt>
        <dd className="min-w-0 break-words">
          <ConditionSummary condition={s.draft.conditions} />
        </dd>
        {needsDestination ? null : (
          <>
            <dt className="text-foreground-subtle">{t("senderLists.ruleSuggestionDestination")}</dt>
            <dd className="text-foreground">{destinationLabel(s.draft.destinationRef ?? "")}</dd>
          </>
        )}
        <dt className="text-foreground-subtle">{t("senderLists.ruleSuggestionPriority")}</dt>
        <dd className="font-mono text-foreground tabular-nums">{s.draft.priority}</dd>
      </dl>
      <p className="text-xs text-foreground-muted">{t("senderLists.ruleSuggestionAffects", { count: s.draft.affected })}</p>

      {canWrite ? (
        <div className="flex flex-wrap items-end gap-2">
          {needsDestination ? (
            <label className="block min-w-[220px] flex-1 text-sm">
              <span className={labelClass}>{t("senderLists.ruleSuggestionDestination")}</span>
              <select value={destination} onChange={(e) => setDestination(e.target.value)} className={inputClass}>
                <option value="">{t("senderLists.ruleSuggestionChooseDestination")}</option>
                <option value="human_review">{t("senderLists.humanReview")}</option>
                {(destinations.data?.data ?? []).map((d) => (
                  <option key={d.id} value={d.name}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <span className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={() => dismiss.mutate(s.id)} loading={dismiss.isPending} disabled={accept.isPending}>
              {t("senderLists.dismiss")}
            </Button>
            {impact ? null : (
              <Button variant="primary" onClick={() => submit(false)} loading={accept.isPending} disabled={needsDestination && !destination}>
                {t("senderLists.createRule")}
              </Button>
            )}
          </span>
        </div>
      ) : null}

      {impact ? (
        <div className="space-y-3">
          <p className="text-xs text-foreground-muted">{t("senderLists.ruleSuggestionImpactIntro")}</p>
          <RuleImpactPanel impact={impact} mode="create" />
          {needsAck ? (
            <label className="flex items-start gap-2 text-sm text-foreground">
              <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-0.5" />
              <span>{t("rules.impactAcknowledge", { to: riskyDestinations(impact, t) })}</span>
            </label>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                accept.reset();
                setAcknowledged(false);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button variant={needsAck ? "danger" : "primary"} onClick={() => submit(true)} loading={accept.isPending} disabled={needsAck && !acknowledged}>
              {t("senderLists.createAnyway")}
            </Button>
          </div>
        </div>
      ) : null}

      {accept.isError && !impact ? (
        <p className="text-xs text-status-danger-fg" role="alert">
          {accept.error instanceof ApiRequestError ? accept.error.message : t("senderLists.ruleSuggestionCreateFailed")}
        </p>
      ) : null}
      {dismiss.isError ? (
        <p className="text-xs text-status-danger-fg" role="alert">
          {dismiss.error instanceof ApiRequestError ? dismiss.error.message : t("senderLists.suggestionUpdateFailed")}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Rules proposed from Human Review decisions grouped by sender AND a subject
 * word — narrower than allowing or blocking a whole sender, since one sender
 * can send both security notices and noise. Nothing changes until someone
 * creates the rule; a risky draft (409 with an impact) needs a second,
 * explicit "Create anyway".
 */
export function RuleSuggestionsPanel() {
  const t = useT();
  const suggestions = useRuleSuggestions();
  const { refresh } = useRuleSuggestionMutations();
  const canWrite = useHasPermission("rules:write") === true;
  const [created, setCreated] = useState<CreatedRule[]>([]);

  if (suggestions.isError || suggestions.isPending) return null;
  const createdIds = new Set(created.map((c) => c.suggestionId));
  const rows = suggestions.data.data.filter((s) => !createdIds.has(s.id));

  return (
    <section className="space-y-3 border border-border bg-surface-raised p-4 rounded-lg" aria-labelledby="rule-suggestions-title">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="rule-suggestions-title" className="text-sm font-semibold text-foreground">
            {t("senderLists.ruleSuggestionsTitle")}
          </h2>
          <p className="text-xs text-foreground-subtle">{t("senderLists.ruleSuggestionsDescription")}</p>
        </div>
        <Button variant="ghost" loading={refresh.isPending} onClick={() => refresh.mutate()}>
          {t("senderLists.checkAgain")}
        </Button>
      </div>

      {created.length > 0 ? (
        <ul className="space-y-1">
          {created.map((c) => (
            <li key={c.ruleId} className="border border-status-success-fg/40 bg-status-success-bg px-3 py-2 text-xs text-status-success-fg" role="status">
              {t.rich(
                "senderLists.ruleSuggestionCreated",
                {
                  link: (chunks) => (
                    <Link href={`/rules/${c.ruleId}`} className="font-medium underline">
                      {chunks}
                    </Link>
                  ),
                },
                { name: c.name },
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {rows.length === 0 ? (
        <p className="text-sm text-foreground-muted">{t("senderLists.ruleSuggestionsEmpty")}</p>
      ) : (
        <ul className="divide-y divide-border border border-border">
          {rows.map((s) => (
            <RuleSuggestionRow key={s.id} suggestion={s} canWrite={canWrite} onCreated={(c) => setCreated((prev) => [...prev, c])} />
          ))}
        </ul>
      )}
    </section>
  );
}
