import { evaluateCondition, type ConditionNode, type EvaluationContext, type EvaluationTrace } from "../rules/conditions.js";
import type { BranchTarget } from "./types.js";

export interface GraphNodeForEvaluation {
  key: string;
  conditions: unknown;
  onTrue: unknown;
  onFalse: unknown;
}

/** One visited node — the full path is persisted on the RoutingDecision so "why did this email go there" is answerable node by node. */
export interface GraphStep {
  nodeKey: string;
  matched: boolean;
  trace: EvaluationTrace;
}

export type GraphEvaluation =
  | { status: "routed"; destinationRef: string; path: GraphStep[] }
  | { status: "invalid"; reason: string; path: GraphStep[] };

function isBranchTarget(value: unknown): value is BranchTarget {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (v.type === "node" && typeof v.nodeKey === "string") || (v.type === "action" && typeof v.destinationRef === "string");
}

/**
 * Walks one graph version from its root: evaluate the node's condition tree
 * (the SAME evaluateCondition() the flat Rule engine uses — identical
 * semantics, including fail-safe-to-false on unresolvable fields), follow
 * onTrue/onFalse, repeat until an "action" branch names a destinationRef.
 *
 * Pure — no I/O. Save-time validation (graphValidation.ts) already rejects
 * cycles, dangling references and orphans, so a well-formed graph always
 * terminates in an action. The checks below are defense in depth against a
 * row that was written some other way: any structural problem is reported
 * as "invalid" (the caller escalates to Human Review), never guessed around.
 */
export function evaluateRuleGraph(rootNodeKey: string, nodes: GraphNodeForEvaluation[], ctx: EvaluationContext): GraphEvaluation {
  const nodesByKey = new Map(nodes.map((n) => [n.key, n]));
  const path: GraphStep[] = [];
  const visited = new Set<string>();
  let currentKey = rootNodeKey;

  for (;;) {
    if (visited.has(currentKey)) return { status: "invalid", reason: `cycle at node "${currentKey}"`, path };
    visited.add(currentKey);

    const node = nodesByKey.get(currentKey);
    if (!node) return { status: "invalid", reason: `node "${currentKey}" does not exist in this graph version`, path };

    const trace = evaluateCondition(node.conditions as ConditionNode, ctx);
    path.push({ nodeKey: node.key, matched: trace.matched, trace });

    const target = trace.matched ? node.onTrue : node.onFalse;
    if (!isBranchTarget(target)) return { status: "invalid", reason: `node "${node.key}" has a malformed ${trace.matched ? "onTrue" : "onFalse"} branch`, path };

    if (target.type === "action") {
      if (!target.destinationRef.trim()) return { status: "invalid", reason: `node "${node.key}" routes to an empty destinationRef`, path };
      return { status: "routed", destinationRef: target.destinationRef, path };
    }
    currentKey = target.nodeKey;
  }
}
