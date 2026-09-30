"use client";

import {
  KNOWN_FIELD_NAMES,
  fieldTypeOf,
  operatorsForField,
  type FieldSource,
  type FieldType,
  type RuleFieldInfo,
} from "@/lib/ruleFields";
import { useRuleFields } from "@/hooks/useRuleFields";
import { Button } from "@/components/ui/Button";
import type { ComparisonOp, ConditionLeaf, ConditionNode } from "@/types/api";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";

function isLeaf(node: ConditionNode): node is ConditionLeaf {
  return "field" in node;
}

export function defaultLeaf(): ConditionLeaf {
  const field = KNOWN_FIELD_NAMES[0]!;
  return { field, op: operatorsForField(field)[0]!, value: "" };
}

const GROUPS: { source: FieldSource; label: MessageKey }[] = [
  { source: "email", label: "rules.fieldGroupEmail" },
  { source: "jev", label: "rules.fieldGroupJev" },
  { source: "derived", label: "rules.fieldGroupDerived" },
  { source: "custom", label: "rules.fieldGroupCustom" },
];

/** Phase 22: a one-line explanation for each derived (arrival-context) field. */
const DERIVED_DESCRIPTIONS: Record<string, MessageKey> = {
  "email.business_hours": "rules.fieldDescBusinessHours",
  "email.is_reply": "rules.fieldDescIsReply",
  "sender.first_email": "rules.fieldDescFirstEmail",
  "sender.emails_last_24h": "rules.fieldDescEmailsLast24h",
  "sender.spf": "rules.fieldDescSpf",
  "sender.dkim": "rules.fieldDescDkim",
  "sender.dmarc": "rules.fieldDescDmarc",
  "sender.authenticated": "rules.fieldDescAuthenticated",
};

/** The value a freshly chosen field starts with — a boolean field gets a real boolean so the true/false select shows what will be saved. */
function initialValue(type: FieldType | undefined): ConditionLeaf["value"] {
  return type === "boolean" ? true : "";
}

function groupFields(
  fields: readonly RuleFieldInfo[],
): Map<FieldSource, RuleFieldInfo[]> {
  const groups = new Map<FieldSource, RuleFieldInfo[]>();
  for (const f of fields) {
    const source: FieldSource = GROUPS.some((g) => g.source === f.source)
      ? f.source
      : "email";
    const list = groups.get(source) ?? [];
    list.push(f);
    groups.set(source, list);
  }
  return groups;
}

function LeafEditor({
  value,
  onChange,
  onRemove,
}: {
  value: ConditionLeaf;
  onChange: (n: ConditionLeaf) => void;
  onRemove?: () => void;
}) {
  const t = useT();
  const { fields } = useRuleFields();
  const fieldType = fieldTypeOf(value.field, fields);
  const ops = operatorsForField(value.field, fields);
  const groups = groupFields(fields);
  // A field the catalog no longer lists (e.g. a removed custom question) stays selectable as-is rather than being silently swapped.
  const isListed = fields.some((f) => f.field === value.field);
  const description = Object.prototype.hasOwnProperty.call(
    DERIVED_DESCRIPTIONS,
    value.field,
  )
    ? DERIVED_DESCRIPTIONS[value.field]
    : undefined;

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={t("rules.fieldAria")}
          value={value.field}
          onChange={(e) => {
            const field = e.target.value;
            onChange({
              field,
              op: operatorsForField(field, fields)[0]!,
              value: initialValue(fieldTypeOf(field, fields)),
            });
          }}
          className="rounded border border-border-strong bg-surface-raised px-2 py-1 text-xs"
        >
          {!isListed ? (
            <option value={value.field}>{value.field}</option>
          ) : null}
          {GROUPS.map((g) => {
            const list = groups.get(g.source);
            if (!list || list.length === 0) return null;
            return (
              <optgroup key={g.source} label={t(g.label)}>
                {list.map((f) => (
                  <option key={f.field} value={f.field}>
                    {f.field}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>

        <select
          aria-label={t("rules.operatorAria")}
          value={value.op}
          onChange={(e) =>
            onChange({ ...value, op: e.target.value as ComparisonOp })
          }
          className="rounded border border-border-strong bg-surface-raised px-2 py-1 text-xs"
        >
          {!ops.includes(value.op) ? (
            <option value={value.op}>{value.op}</option>
          ) : null}
          {ops.map((op) => (
            <option key={op} value={op}>
              {op}
            </option>
          ))}
        </select>

        {value.op === "in" ? (
          <input
            aria-label={t("rules.valueListAria")}
            type="text"
            value={Array.isArray(value.value) ? value.value.join(",") : ""}
            onChange={(e) =>
              onChange({
                ...value,
                value: e.target.value
                  .split(",")
                  .map((v) => v.trim())
                  .filter(Boolean),
              })
            }
            placeholder={t("rules.valueListPlaceholder")}
            className="min-w-[140px] rounded border border-border-strong bg-surface-raised px-2 py-1 text-xs"
          />
        ) : fieldType === "boolean" ? (
          <select
            aria-label={t("rules.valueAria")}
            value={String(value.value)}
            onChange={(e) =>
              onChange({ ...value, value: e.target.value === "true" })
            }
            className="rounded border border-border-strong bg-surface-raised px-2 py-1 text-xs"
          >
            {typeof value.value !== "boolean" ? (
              <option value={String(value.value)}>—</option>
            ) : null}
            <option value="true">{t("rules.valueTrue")}</option>
            <option value="false">{t("rules.valueFalse")}</option>
          </select>
        ) : fieldType === "number" ? (
          <input
            aria-label={t("rules.valueAria")}
            type="number"
            step="any"
            value={typeof value.value === "number" ? value.value : ""}
            onChange={(e) =>
              onChange({ ...value, value: e.target.valueAsNumber })
            }
            className="w-24 rounded border border-border-strong bg-surface-raised px-2 py-1 text-xs"
          />
        ) : (
          <input
            aria-label={t("rules.valueAria")}
            type="text"
            value={typeof value.value === "string" ? value.value : ""}
            onChange={(e) => onChange({ ...value, value: e.target.value })}
            className="min-w-[140px] rounded border border-border-strong bg-surface-raised px-2 py-1 text-xs"
          />
        )}

        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="text-xs text-status-danger-fg hover:underline"
          >
            {t("rules.remove")}
          </button>
        ) : null}
      </div>
      {description ? (
        <p className="text-[11px] text-foreground-subtle">{t(description)}</p>
      ) : null}
    </div>
  );
}

/**
 * §17: a recursive editor for the EXACT backend condition model — leaf / AND
 * / OR / NOT, and only the fields/operators knownFields.ts actually supports
 * (fetched from GET /rules/fields; lib/ruleFields.ts holds the fallback). No new operators are invented, and
 * nothing here silently reshapes an unsupported condition — an invalid tree
 * is caught by the backend's own validateRule() on submit and surfaced as a
 * normal VALIDATION_ERROR (see app/rules/[id]/page.tsx).
 */
export function ConditionEditor({
  value,
  onChange,
  onRemove,
}: {
  value: ConditionNode;
  onChange: (n: ConditionNode) => void;
  onRemove?: () => void;
}) {
  const t = useT();
  if (isLeaf(value)) {
    return <LeafEditor value={value} onChange={onChange} onRemove={onRemove} />;
  }

  if (value.op === "NOT") {
    return (
      <div className="space-y-2 rounded-md border border-border-strong p-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
            NOT
          </span>
          {onRemove ? (
            <button
              type="button"
              onClick={onRemove}
              className="text-xs text-status-danger-fg hover:underline"
            >
              {t("rules.remove")}
            </button>
          ) : null}
        </div>
        <div className="border-l border-border pl-3">
          <ConditionEditor
            value={value.child}
            onChange={(child) => onChange({ op: "NOT", child })}
          />
        </div>
      </div>
    );
  }

  // AND / OR group
  const group = value;
  return (
    <div className="space-y-2 rounded-md border border-border-strong p-2">
      <div className="flex items-center justify-between">
        <select
          aria-label={t("rules.groupOperatorAria")}
          value={group.op}
          onChange={(e) =>
            onChange({ ...group, op: e.target.value as "AND" | "OR" })
          }
          className="rounded border border-border-strong bg-surface-raised px-2 py-1 text-xs font-semibold"
        >
          <option value="AND">AND</option>
          <option value="OR">OR</option>
        </select>
        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="text-xs text-status-danger-fg hover:underline"
          >
            {t("rules.removeGroup")}
          </button>
        ) : null}
      </div>
      <div className="space-y-2 border-l border-border pl-3">
        {group.children.map((child, i) => (
          <ConditionEditor
            key={i}
            value={child}
            onChange={(next) => {
              const children = [...group.children];
              children[i] = next;
              onChange({ ...group, children });
            }}
            onRemove={() =>
              onChange({
                ...group,
                children: group.children.filter((_, idx) => idx !== i),
              })
            }
          />
        ))}
        {group.children.length === 0 ? (
          <p className="text-xs text-foreground-subtle">
            {t("rules.emptyGroup")}
          </p>
        ) : null}
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() =>
            onChange({ ...group, children: [...group.children, defaultLeaf()] })
          }
        >
          {t("rules.addCondition")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() =>
            onChange({
              ...group,
              children: [
                ...group.children,
                { op: "AND", children: [defaultLeaf()] },
              ],
            })
          }
        >
          {t("rules.addGroup")}
        </Button>
      </div>
    </div>
  );
}
