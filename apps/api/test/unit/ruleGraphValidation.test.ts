import { describe, expect, it } from "vitest";
import { validateRuleGraph } from "../../src/modules/rule-graphs/graphValidation.js";
import { evaluateCondition } from "../../src/modules/rules/conditions.js";
import type { RuleGraphInput } from "../../src/modules/rule-graphs/types.js";

/** The example from the Phase 9 brief: IF sender contains "github.com" -> node B; ELSE -> Archive. Node B: IF subject contains "security" -> SecurityWebhook; ELSE -> Archive. */
function validGraph(): RuleGraphInput {
  return {
    name: "GitHub triage",
    rootNodeKey: "start",
    nodes: [
      {
        key: "start",
        conditions: { field: "sender.address", op: "contains", value: "github.com" },
        onTrue: { type: "node", nodeKey: "check-security" },
        onFalse: { type: "action", destinationRef: "archive" },
      },
      {
        key: "check-security",
        conditions: { field: "subject", op: "contains", value: "security" },
        onTrue: { type: "action", destinationRef: "security-webhook" },
        onFalse: { type: "action", destinationRef: "archive" },
      },
    ],
  };
}

describe("validateRuleGraph — creating a valid graph", () => {
  it("accepts a well-formed two-node branching graph", () => {
    expect(validateRuleGraph(validGraph())).toEqual([]);
  });

  it("accepts a single-node graph where both branches are terminal actions", () => {
    const graph: RuleGraphInput = {
      name: "single node",
      rootNodeKey: "only",
      nodes: [
        {
          key: "only",
          conditions: { field: "has_attachment", op: "==", value: true },
          onTrue: { type: "action", destinationRef: "archive" },
          onFalse: { type: "action", destinationRef: "human_review" },
        },
      ],
    };
    expect(validateRuleGraph(graph)).toEqual([]);
  });
});

describe("validateRuleGraph — malformed graphs", () => {
  it("rejects an empty name", () => {
    const graph = { ...validGraph(), name: "  " };
    expect(validateRuleGraph(graph)).toContain("name must not be empty");
  });

  it("rejects a graph with zero nodes", () => {
    const graph: RuleGraphInput = { name: "empty", rootNodeKey: "start", nodes: [] };
    expect(validateRuleGraph(graph)).toContain("graph must contain at least one node");
  });

  it("rejects a node whose OWN condition tree is invalid — reusing validateConditionTree, not a second implementation", () => {
    const graph = validGraph();
    graph.nodes[0]!.conditions = { field: "not.a.real.field", op: "==", value: "x" };
    const errors = validateRuleGraph(graph);
    expect(errors.some((e) => e.includes("unknown field"))).toBe(true);
  });

  it("rejects a malformed branch target (missing type)", () => {
    const graph = validGraph();
    // @ts-expect-error deliberately malformed for this test
    graph.nodes[0]!.onTrue = { nodeKey: "check-security" };
    const errors = validateRuleGraph(graph);
    expect(errors.some((e) => e.includes("malformed branch target"))).toBe(true);
  });

  it("rejects an action branch with an empty destinationRef", () => {
    const graph = validGraph();
    graph.nodes[0]!.onFalse = { type: "action", destinationRef: "  " };
    const errors = validateRuleGraph(graph);
    expect(errors.some((e) => e.includes("action branch requires a non-empty destinationRef"))).toBe(true);
  });
});

describe("validateRuleGraph — invalid branch references", () => {
  it("rejects a node branch pointing at a key that doesn't exist", () => {
    const graph = validGraph();
    graph.nodes[0]!.onTrue = { type: "node", nodeKey: "does-not-exist" };
    const errors = validateRuleGraph(graph);
    expect(errors.some((e) => e.includes('references unknown node "does-not-exist"'))).toBe(true);
  });

  it("rejects an invalid root node key", () => {
    const graph = { ...validGraph(), rootNodeKey: "missing" };
    const errors = validateRuleGraph(graph);
    expect(errors.some((e) => e.includes('rootNodeKey "missing" does not reference a node'))).toBe(true);
  });

  it("rejects duplicate node keys", () => {
    const graph = validGraph();
    graph.nodes.push({ ...graph.nodes[1]!, key: "start" }); // "start" now used twice
    const errors = validateRuleGraph(graph);
    expect(errors.some((e) => e.includes("duplicate node key"))).toBe(true);
  });

  it("rejects an orphaned node — present in the graph but unreachable from the root", () => {
    const graph = validGraph();
    graph.nodes.push({
      key: "orphan",
      conditions: { field: "has_attachment", op: "==", value: true },
      onTrue: { type: "action", destinationRef: "archive" },
      onFalse: { type: "action", destinationRef: "archive" },
    });
    const errors = validateRuleGraph(graph);
    expect(errors.some((e) => e.includes("orphaned node") && e.includes("orphan"))).toBe(true);
  });

  it("rejects a cycle — node A's branch eventually leads back to node A", () => {
    const graph = validGraph();
    // check-security's onFalse now points back at start instead of a terminal action.
    graph.nodes[1]!.onFalse = { type: "node", nodeKey: "start" };
    const errors = validateRuleGraph(graph);
    expect(errors.some((e) => e.includes("cycle detected"))).toBe(true);
  });

  it("rejects a self-referencing single-node cycle", () => {
    const graph: RuleGraphInput = {
      name: "self loop",
      rootNodeKey: "start",
      nodes: [
        {
          key: "start",
          conditions: { field: "has_attachment", op: "==", value: true },
          onTrue: { type: "node", nodeKey: "start" },
          onFalse: { type: "action", destinationRef: "archive" },
        },
      ],
    };
    const errors = validateRuleGraph(graph);
    expect(errors.some((e) => e.includes("cycle detected"))).toBe(true);
  });
});

describe("validateRuleGraph — preserving the existing condition evaluator", () => {
  it("a RuleNode's conditions field is the exact same ConditionNode shape evaluateCondition() already handles — no new evaluator was introduced", () => {
    const graph = validGraph();
    const startNode = graph.nodes.find((n) => n.key === "start")!;

    const matchTrace = evaluateCondition(startNode.conditions, {
      email: { fromAddress: "alerts@github.com", toAddresses: [], subject: "test", hasAttachments: false, attachmentFilenames: [] },
      answers: {},
    });
    expect(matchTrace.matched).toBe(true);

    const noMatchTrace = evaluateCondition(startNode.conditions, {
      email: { fromAddress: "alerts@example.com", toAddresses: [], subject: "test", hasAttachments: false, attachmentFilenames: [] },
      answers: {},
    });
    expect(noMatchTrace.matched).toBe(false);
  });
});
