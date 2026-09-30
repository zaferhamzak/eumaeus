"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { ConditionEditor } from "@/components/rules/ConditionEditor";
import { ApiRequestError } from "@/lib/api/client";
import type { ConditionNode } from "@/types/api";
import { previewRuleImpact, type RuleImpact, type RuleInput, type SaveRuleOptions } from "@/lib/api/rules";
import { SimulationPanel } from "@/components/rules/SimulationPanel";
import { RuleImpactPanel, riskyDestinations } from "@/components/rules/RuleImpactPanel";
import { useT } from "@/lib/i18n/I18nProvider";
import type { Translate } from "@/lib/i18n/translate";

export interface RuleFormValue {
  name: string;
  priority: number;
  destinationRef: string;
  conditions: ConditionNode;
}

/** §17: client-side validation happens BEFORE any request is sent — obvious problems (empty name, empty destination, an empty AND/OR group) are caught here; the backend's own validateRule() remains the real authority for everything else (an unresolvable field/operator combination, priority collisions), surfaced as a normal error message if it rejects the submission. */
function validate(value: RuleFormValue, t: Translate): string[] {
  const errors: string[] = [];
  if (!value.name.trim()) errors.push(t("rules.errNameEmpty"));
  if (!Number.isInteger(value.priority)) errors.push(t("rules.errPriorityInteger"));
  if (!value.destinationRef.trim()) errors.push(t("rules.errDestinationEmpty"));
  errors.push(...validateTree(value.conditions, "conditions", t));
  return errors;
}

function validateTree(node: ConditionNode, path: string, t: Translate): string[] {
  if ("field" in node) {
    if (node.op === "in" && !Array.isArray(node.value)) return [t("rules.errInRequiresValue", { path })];
    if (Array.isArray(node.value) && node.value.length === 0) return [t("rules.errInRequiresValue", { path })];
    return [];
  }
  if (node.op === "NOT") return validateTree(node.child, `${path}.NOT`, t);
  if (node.children.length === 0) return [t("rules.errGroupEmpty", { path: `${path}.${node.op}` })];
  return node.children.flatMap((c, i) => validateTree(c, `${path}.${node.op}[${i}]`, t));
}

export function RuleForm({
  initial,
  submitLabel,
  onSubmit,
  isSubmitting,
  submitError,
  versioningNotice,
  replaceRuleId,
}: {
  initial: RuleFormValue;
  submitLabel: string;
  /** Called after the impact check: directly when nothing would change, otherwise once the user confirmed (then with `confirmImpact: true`). */
  onSubmit: (input: RuleInput, options: SaveRuleOptions) => void;
  isSubmitting: boolean;
  submitError?: unknown;
  versioningNotice?: string;
  /** Editing an existing rule: the simulation swaps this rule for the draft instead of adding it. */
  replaceRuleId?: string;
}) {
  const t = useT();
  const [name, setNameRaw] = useState(initial.name);
  const [priority, setPriorityRaw] = useState(initial.priority);
  const [destinationRef, setDestinationRefRaw] = useState(initial.destinationRef);
  const [conditions, setConditionsRaw] = useState<ConditionNode>(initial.conditions);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  // Impact check (POST /rules/impact) of exactly the values it was run for;
  // any edit discards it, so a confirmation always refers to what is saved.
  const [impact, setImpact] = useState<RuleImpact | null>(null);
  const [checking, setChecking] = useState(false);
  const [impactError, setImpactError] = useState<unknown>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  function discardImpact() {
    setImpact(null);
    setImpactError(null);
    setAcknowledged(false);
  }
  const edit =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setter(v);
      discardImpact();
    };
  const setName = edit(setNameRaw);
  const setPriority = edit(setPriorityRaw);
  const setDestinationRef = edit(setDestinationRefRaw);
  const setConditions = edit(setConditionsRaw);

  const needsAck = (impact?.risky.count ?? 0) > 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const value: RuleFormValue = { name, priority, destinationRef, conditions };
    const errors = validate(value, t);
    setValidationErrors(errors);
    if (errors.length > 0) return;

    if (impact) {
      if (needsAck && !acknowledged) return;
      onSubmit(value, { confirmImpact: true });
      return;
    }

    setChecking(true);
    setImpactError(null);
    try {
      const result = await previewRuleImpact(replaceRuleId ? { type: "update", ruleId: replaceRuleId, rule: value } : { type: "create", rule: value });
      if (result.changed === 0 && result.risky.count === 0) onSubmit(value, {});
      else setImpact(result);
    } catch (error) {
      setImpactError(error);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="space-y-5">
      <form onSubmit={handleSubmit} className="space-y-5">
        {versioningNotice ? <p className="rounded-md bg-status-info-bg px-3 py-2 text-xs text-status-info-fg">{versioningNotice}</p> : null}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <label className="block text-sm">
            <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{t("rules.name")}</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{t("rules.priority")}</span>
            <input
              type="number"
              value={priority}
              onChange={(e) => setPriority(e.target.valueAsNumber)}
              required
              className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm font-mono"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{t("rules.destination")}</span>
            <input
              type="text"
              value={destinationRef}
              onChange={(e) => setDestinationRef(e.target.value)}
              placeholder={t("rules.destinationPlaceholder")}
              required
              className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
            />
          </label>
        </div>

        <div>
          <p className="mb-1.5 text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{t("rules.conditions")}</p>
          <ConditionEditor value={conditions} onChange={setConditions} />
        </div>

        {validationErrors.length > 0 ? (
          <ul className="space-y-1 rounded-md bg-status-danger-bg px-3 py-2 text-sm text-status-danger-fg" role="alert">
            {validationErrors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        ) : null}

        {submitError ? (
          <p className="rounded-md bg-status-danger-bg px-3 py-2 text-sm text-status-danger-fg" role="alert">
            {submitError instanceof ApiRequestError ? submitError.message : t("rules.saveFailed")}
          </p>
        ) : null}

        {impactError ? (
          <p className="rounded-md bg-status-danger-bg px-3 py-2 text-sm text-status-danger-fg" role="alert">
            {impactError instanceof ApiRequestError ? impactError.message : t("rules.impactFailed")}
          </p>
        ) : null}

        {impact ? (
          <div className="space-y-3">
            <p className="rounded-md bg-status-info-bg px-3 py-2 text-xs text-status-info-fg">{t("rules.impactReviewHint")}</p>
            <RuleImpactPanel impact={impact} mode={replaceRuleId ? "update" : "create"} />
            {needsAck ? (
              <label className="flex items-start gap-2 text-sm text-foreground">
                <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-0.5" />
                <span>{t("rules.impactAcknowledge", { to: riskyDestinations(impact, t) })}</span>
              </label>
            ) : null}
          </div>
        ) : null}

        <Button type="submit" variant={needsAck ? "danger" : "primary"} loading={isSubmitting || checking} disabled={needsAck && !acknowledged}>
          {impact ? t("rules.saveWithImpact") : submitLabel}
        </Button>
      </form>

      <SimulationPanel
        noun="rule"
        getTarget={() => {
          const value: RuleFormValue = { name, priority, destinationRef, conditions };
          const errors = validate(value, t);
          if (errors.length > 0) return { error: t("rules.fixFormFirst", { error: errors[0] ?? "" }) };
          return { type: "rule", rule: value, ...(replaceRuleId ? { replaceRuleId } : {}) };
        }}
      />
    </div>
  );
}

