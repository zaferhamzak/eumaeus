import { describe, expect, it } from "vitest";
import { evaluateRuleGraph, type GraphNodeForEvaluation } from "../../src/modules/rule-graphs/evaluateGraph.js";
import type { EvaluationContext } from "../../src/modules/rules/conditions.js";

function ctx(answers: Record<string, unknown>, subject = "hello"): EvaluationContext {
  return {
    email: { fromAddress: "a@example.com", toAddresses: ["b@example.com"], subject, hasAttachments: false, attachmentFilenames: [] },
    answers,
  };
}

// spam? -> archive-spam : (invoice? -> accounting : sales)
const graph: GraphNodeForEvaluation[] = [
  {
    key: "is-spam",
    conditions: { field: "answers.is_spam", op: ">=", value: 0.8 },
    onTrue: { type: "action", destinationRef: "spam-folder" },
    onFalse: { type: "node", nodeKey: "is-invoice" },
  },
  {
    key: "is-invoice",
    conditions: { field: "answers.category", op: "==", value: "invoice" },
    onTrue: { type: "action", destinationRef: "accounting" },
    onFalse: { type: "action", destinationRef: "sales" },
  },
];

describe("evaluateRuleGraph", () => {
  it("routes on the root node's TRUE branch without visiting further nodes", () => {
    const result = evaluateRuleGraph("is-spam", graph, ctx({ is_spam: { noul: 0.95 } }));
    expect(result).toMatchObject({ status: "routed", destinationRef: "spam-folder" });
    expect(result.path.map((s) => [s.nodeKey, s.matched])).toEqual([["is-spam", true]]);
  });

  it("follows FALSE to the next node and routes from there", () => {
    const result = evaluateRuleGraph("is-spam", graph, ctx({ is_spam: { noul: 0.1 }, category: { choice: "invoice", confidence: 0.9 } }));
    expect(result).toMatchObject({ status: "routed", destinationRef: "accounting" });
    expect(result.path.map((s) => [s.nodeKey, s.matched])).toEqual([
      ["is-spam", false],
      ["is-invoice", true],
    ]);
  });

  it("an unresolvable field fails safe to false (same semantics as the flat engine)", () => {
    const result = evaluateRuleGraph("is-spam", graph, ctx({}));
    expect(result).toMatchObject({ status: "routed", destinationRef: "sales" });
  });

  it("reports a missing root as invalid rather than guessing", () => {
    expect(evaluateRuleGraph("nope", graph, ctx({})).status).toBe("invalid");
  });

  it("reports a dangling node reference as invalid", () => {
    const broken: GraphNodeForEvaluation[] = [
      { key: "a", conditions: { field: "subject", op: "==", value: "x" }, onTrue: { type: "action", destinationRef: "d" }, onFalse: { type: "node", nodeKey: "ghost" } },
    ];
    const result = evaluateRuleGraph("a", broken, ctx({}));
    expect(result).toMatchObject({ status: "invalid" });
    expect(result.path).toHaveLength(1);
  });

  it("terminates on a cycle (defense in depth — save-time validation already rejects these)", () => {
    const cyclic: GraphNodeForEvaluation[] = [
      { key: "a", conditions: { field: "subject", op: "==", value: "never" }, onTrue: { type: "action", destinationRef: "d" }, onFalse: { type: "node", nodeKey: "b" } },
      { key: "b", conditions: { field: "subject", op: "==", value: "never" }, onTrue: { type: "action", destinationRef: "d" }, onFalse: { type: "node", nodeKey: "a" } },
    ];
    const result = evaluateRuleGraph("a", cyclic, ctx({}));
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") expect(result.reason).toContain("cycle");
  });

  it("reports a malformed branch target as invalid", () => {
    const malformed: GraphNodeForEvaluation[] = [{ key: "a", conditions: { field: "subject", op: "==", value: "hello" }, onTrue: { oops: true }, onFalse: null }];
    expect(evaluateRuleGraph("a", malformed, ctx({})).status).toBe("invalid");
  });
});
