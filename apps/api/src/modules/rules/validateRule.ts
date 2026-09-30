import { isConditionLeaf, type ConditionNode } from "./conditions.js";
import { KNOWN_FIELDS, type FieldType } from "./knownFields.js";
import type { ExtraFields } from "./customFields.js";

/**
 * Save-time validation (implementation-plan.md-style "fail loudly before
 * persisting," not at evaluation time) — this phase's §9 "rule configuration is
 * invalid" case is handled primarily HERE: an invalid rule is rejected before it
 * can ever become `enabled`. conditions.ts's evaluator is a second, defensive
 * layer for whatever slips through (e.g. a future schema change), never the
 * primary gate.
 */
export interface RuleInput {
  name: string;
  priority: number;
  conditions: ConditionNode;
  destinationRef: string;
}

const NUMERIC_OPS = new Set(["<", "<=", ">", ">="]);

/** `extraFields`: Phase 22 — the organization's own question fields (see customFields.ts). */
export function validateConditionTree(node: ConditionNode, path = "conditions", extraFields: ExtraFields = {}): string[] {
  const errors: string[] = [];

  if (isConditionLeaf(node)) {
    const fieldType: FieldType | undefined = KNOWN_FIELDS[node.field] ?? extraFields[node.field];
    if (!fieldType) {
      errors.push(`${path}: unknown field "${node.field}"`);
      return errors; // no point type-checking the operator against an unknown field
    }

    if (NUMERIC_OPS.has(node.op) && fieldType !== "number") {
      errors.push(`${path}: operator "${node.op}" is not valid on field "${node.field}" (type ${fieldType})`);
    }
    if (node.op === "contains" && fieldType !== "string" && fieldType !== "string[]") {
      errors.push(`${path}: operator "contains" is not valid on field "${node.field}" (type ${fieldType})`);
    }
    if (node.op === "in" && !Array.isArray(node.value)) {
      errors.push(`${path}: operator "in" requires an array value on field "${node.field}"`);
    }
    if (NUMERIC_OPS.has(node.op) && typeof node.value !== "number") {
      errors.push(`${path}: operator "${node.op}" on field "${node.field}" requires a numeric value`);
    }
    return errors;
  }

  if (node.op === "NOT") {
    return validateConditionTree(node.child, `${path}.NOT`, extraFields);
  }

  if (node.children.length === 0) {
    errors.push(`${path}.${node.op}: must have at least one child`);
  }
  node.children.forEach((child, i) => {
    errors.push(...validateConditionTree(child, `${path}.${node.op}[${i}]`, extraFields));
  });
  return errors;
}

export function validateRule(input: RuleInput, extraFields: ExtraFields = {}): string[] {
  const errors: string[] = [];
  if (!input.name.trim()) errors.push("name must not be empty");
  if (!Number.isInteger(input.priority)) errors.push("priority must be an integer");
  if (!input.destinationRef.trim()) errors.push("destinationRef must not be empty");
  errors.push(...validateConditionTree(input.conditions, "conditions", extraFields));
  return errors;
}
