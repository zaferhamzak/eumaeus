import { describe, expect, it } from "vitest";
import { validateConditionTree, validateRule, type RuleInput } from "../../src/modules/rules/validateRule.js";
import type { ConditionNode } from "../../src/modules/rules/conditions.js";

describe("validateConditionTree", () => {
  it("accepts a well-formed tree", () => {
    const tree: ConditionNode = {
      op: "AND",
      children: [
        { field: "sender.domain", op: "==", value: "example.com" },
        { field: "answers.is_customer_related", op: "==", value: true },
      ],
    };
    expect(validateConditionTree(tree)).toEqual([]);
  });

  it("rejects an unknown field", () => {
    const tree: ConditionNode = { field: "answers.not_a_real_signal", op: "==", value: true };
    const errors = validateConditionTree(tree);
    expect(errors.some((e) => e.includes("unknown field"))).toBe(true);
  });

  it("rejects a numeric operator on a non-numeric field", () => {
    const tree: ConditionNode = { field: "sender.domain", op: ">=", value: "x" };
    const errors = validateConditionTree(tree);
    expect(errors.some((e) => e.includes('operator ">="'))).toBe(true);
  });

  it("rejects 'contains' on a boolean field", () => {
    const tree: ConditionNode = { field: "has_attachment", op: "contains", value: "x" };
    const errors = validateConditionTree(tree);
    expect(errors.some((e) => e.includes("contains"))).toBe(true);
  });

  it("rejects 'in' with a non-array value", () => {
    const tree: ConditionNode = { field: "sender.domain", op: "in", value: "example.com" as never };
    const errors = validateConditionTree(tree);
    expect(errors.some((e) => e.includes("requires an array"))).toBe(true);
  });

  it("rejects a numeric operator with a non-numeric value", () => {
    const tree: ConditionNode = { field: "answers.urgency", op: ">=", value: "high" as never };
    const errors = validateConditionTree(tree);
    expect(errors.some((e) => e.includes("requires a numeric value"))).toBe(true);
  });

  it("rejects an AND/OR group with zero children", () => {
    const tree: ConditionNode = { op: "AND", children: [] };
    const errors = validateConditionTree(tree);
    expect(errors.some((e) => e.includes("at least one child"))).toBe(true);
  });

  it("validates recursively through NOT and nested groups, reporting the exact path", () => {
    const tree: ConditionNode = {
      op: "OR",
      children: [{ op: "NOT", child: { field: "answers.bogus_field", op: "==", value: true } }],
    };
    const errors = validateConditionTree(tree);
    expect(errors[0]).toContain("conditions.OR[0].NOT");
  });
});

describe("validateRule", () => {
  const validInput: RuleInput = {
    name: "Business collaboration",
    priority: 10,
    destinationRef: "partnerships",
    conditions: { field: "answers.is_collaboration", op: "==", value: true },
  };

  it("accepts a valid rule", () => {
    expect(validateRule(validInput)).toEqual([]);
  });

  it("rejects an empty name", () => {
    expect(validateRule({ ...validInput, name: "  " })).toContain("name must not be empty");
  });

  it("rejects a non-integer priority", () => {
    expect(validateRule({ ...validInput, priority: 1.5 })).toContain("priority must be an integer");
  });

  it("rejects an empty destinationRef", () => {
    expect(validateRule({ ...validInput, destinationRef: "" })).toContain("destinationRef must not be empty");
  });

  it("bubbles up condition tree errors", () => {
    const errors = validateRule({ ...validInput, conditions: { field: "not.real", op: "==", value: 1 } });
    expect(errors.some((e) => e.includes("unknown field"))).toBe(true);
  });
});
