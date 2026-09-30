"use client";

import { useId, useState } from "react";
import { ConditionEditor, defaultLeaf } from "@/components/rules/ConditionEditor";
import { Button } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { ApiRequestError } from "@/lib/api/client";
import { useDestinationsList } from "@/hooks/useDestinations";
import { useValidateRuleGraph } from "@/hooks/useRuleGraphs";
import { SimulationPanel } from "@/components/rules/SimulationPanel";
import type { BranchTarget, RuleGraphInput, RuleNodeInput } from "@/types/api";
import { useT } from "@/lib/i18n/I18nProvider";

const inputClass = "w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm";
const labelClass = "mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase";

function newNode(existingKeys: string[]): RuleNodeInput {
  let n = existingKeys.length + 1;
  while (existingKeys.includes(`step-${n}`)) n += 1;
  return {
    key: `step-${n}`,
    conditions: defaultLeaf(),
    onTrue: { type: "action", destinationRef: "human_review" },
    onFalse: { type: "action", destinationRef: "human_review" },
  };
}

function BranchTargetEditor({
  label,
  value,
  onChange,
  nodeKeys,
  destinationListId,
}: {
  label: string;
  value: BranchTarget;
  onChange: (t: BranchTarget) => void;
  nodeKeys: string[];
  destinationListId: string;
}) {
  const t = useT();
  return (
    <div className="space-y-1">
      <span className={labelClass}>{label}</span>
      <div className="flex gap-2">
        <select
          value={value.type}
          onChange={(e) =>
            onChange(e.target.value === "node" ? { type: "node", nodeKey: nodeKeys[0] ?? "" } : { type: "action", destinationRef: "human_review" })
          }
          className="rounded-md border border-border-strong bg-surface-raised px-2 py-1.5 text-sm"
        >
          <option value="action">{t("ruleGraphs.routeTo")}</option>
          <option value="node" disabled={nodeKeys.length === 0}>
            {t("ruleGraphs.goToStep")}
          </option>
        </select>
        {value.type === "node" ? (
          <select value={value.nodeKey} onChange={(e) => onChange({ type: "node", nodeKey: e.target.value })} className={inputClass}>
            {nodeKeys.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        ) : (
          <input
            list={destinationListId}
            value={value.destinationRef}
            onChange={(e) => onChange({ type: "action", destinationRef: e.target.value })}
            placeholder={t("ruleGraphs.destinationPlaceholder")}
            className={inputClass}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Each step evaluates one condition (the SAME condition editor and
 * semantics as flat rules) and branches: "Go to step" continues, "Route to"
 * ends at a destination (or the reserved human_review). The backend rejects
 * cycles, dangling steps and steps nothing leads to — "Check" runs that
 * exact validation without saving.
 */
export function RuleGraphEditor({
  initial,
  submitLabel,
  submitting,
  error,
  onSubmit,
}: {
  initial?: RuleGraphInput;
  submitLabel: string;
  submitting: boolean;
  error: unknown;
  onSubmit: (input: RuleGraphInput) => void;
}) {
  const t = useT();
  const destinations = useDestinationsList();
  const validate = useValidateRuleGraph();
  const destinationListId = useId();
  const [name, setName] = useState(initial?.name ?? "");
  const [nodes, setNodes] = useState<RuleNodeInput[]>(initial?.nodes ?? [newNode([])]);
  const [rootNodeKey, setRootNodeKey] = useState(initial?.rootNodeKey ?? nodes[0]?.key ?? "");

  const keys = nodes.map((n) => n.key);
  const current = (): RuleGraphInput => ({ name, rootNodeKey, nodes });

  function updateNode(index: number, patch: Partial<RuleNodeInput>) {
    setNodes((prev) => prev.map((n, i) => (i === index ? { ...n, ...patch } : n)));
  }

  /** Renaming a step rewrites every reference to it (root + branches), so a rename never silently breaks the graph. */
  function renameNode(index: number, newKey: string) {
    const oldKey = nodes[index]?.key;
    const retarget = (t: BranchTarget): BranchTarget => (t.type === "node" && t.nodeKey === oldKey ? { type: "node", nodeKey: newKey } : t);
    setNodes((prev) => prev.map((n, i) => ({ ...n, key: i === index ? newKey : n.key, onTrue: retarget(n.onTrue), onFalse: retarget(n.onFalse) })));
    if (rootNodeKey === oldKey) setRootNodeKey(newKey);
  }

  function removeNode(index: number) {
    const removed = nodes[index]?.key;
    const next = nodes.filter((_, i) => i !== index);
    setNodes(next);
    if (rootNodeKey === removed) setRootNodeKey(next[0]?.key ?? "");
  }

  const validationResult = validate.data;

  return (
    <div className="space-y-4">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(current());
        }}
      >
        <datalist id={destinationListId}>
          <option value="human_review" />
          {(destinations.data?.data ?? []).map((d) => (
            <option key={d.id} value={d.name} />
          ))}
        </datalist>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className={labelClass}>{t("ruleGraphs.name")}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required className={inputClass} />
          </label>
          <label className="block text-sm">
            <span className={labelClass}>{t("ruleGraphs.startAtStep")}</span>
            <select value={rootNodeKey} onChange={(e) => setRootNodeKey(e.target.value)} className={inputClass}>
              {keys.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </label>
        </div>

        {nodes.map((node, index) => {
          const otherKeys = keys.filter((k) => k !== node.key);
          return (
            <Card key={index}>
              <CardBody className="space-y-3">
                <div className="flex items-end gap-2">
                  <label className="block flex-1 text-sm">
                    <span className={labelClass}>{node.key === rootNodeKey ? t("ruleGraphs.stepLabelStart") : t("ruleGraphs.stepLabel")}</span>
                    <input value={node.key} onChange={(e) => renameNode(index, e.target.value)} required className={`${inputClass} font-mono`} />
                  </label>
                  {nodes.length > 1 ? (
                    <Button type="button" variant="ghost" onClick={() => removeNode(index)}>
                      {t("ruleGraphs.removeStep")}
                    </Button>
                  ) : null}
                </div>
                <div>
                  <span className={labelClass}>{t("ruleGraphs.ifLabel")}</span>
                  <ConditionEditor value={node.conditions} onChange={(conditions) => updateNode(index, { conditions })} />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <BranchTargetEditor
                    label={t("ruleGraphs.thenTrue")}
                    value={node.onTrue}
                    onChange={(onTrue) => updateNode(index, { onTrue })}
                    nodeKeys={otherKeys}
                    destinationListId={destinationListId}
                  />
                  <BranchTargetEditor
                    label={t("ruleGraphs.otherwiseFalse")}
                    value={node.onFalse}
                    onChange={(onFalse) => updateNode(index, { onFalse })}
                    nodeKeys={otherKeys}
                    destinationListId={destinationListId}
                  />
                </div>
              </CardBody>
            </Card>
          );
        })}

        <Button type="button" variant="secondary" onClick={() => setNodes((prev) => [...prev, newNode(keys)])}>
          {t("ruleGraphs.addStep")}
        </Button>

        {validationResult ? (
          validationResult.valid ? (
            <p className="text-sm text-status-success-fg">{t("ruleGraphs.valid")}</p>
          ) : (
            <ul className="list-disc space-y-0.5 pl-5 text-sm text-status-danger-fg" role="alert">
              {validationResult.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )
        ) : null}
        {error ? (
          <p className="text-sm text-status-danger-fg" role="alert">
            {error instanceof ApiRequestError ? error.message : t("ruleGraphs.saveFailed")}
          </p>
        ) : null}

        <div className="flex gap-2">
          <Button type="button" variant="secondary" loading={validate.isPending} onClick={() => validate.mutate(current())}>
            {t("ruleGraphs.check")}
          </Button>
          <Button type="submit" variant="primary" loading={submitting}>
            {submitLabel}
          </Button>
        </div>
      </form>

      <SimulationPanel
        noun="graph"
        getTarget={() => {
          if (!name.trim()) return { error: t("ruleGraphs.nameFirst") };
          return { type: "graph", graph: current() };
        }}
      />
    </div>
  );
}
