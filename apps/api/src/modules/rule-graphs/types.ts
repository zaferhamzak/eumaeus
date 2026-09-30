import type { ConditionNode } from "../rules/conditions.js";

/**
 * Where a graph branch leads. `"node"` continues evaluation at another
 * RuleNode (by `key`, within the same graph version). `"action"` is an
 * explicit, deliberately minimal placeholder — a plain destinationRef
 * string, mirroring Rule.destinationRef's existing semantics
 * (dispatch-to-destination-or-the-reserved-"human_review"-literal) — NOT the
 * future full Action entity (params, side effects, retry policy, ...), which
 * is out of scope for this phase.
 */
export type BranchTarget = { type: "node"; nodeKey: string } | { type: "action"; destinationRef: string };

export interface RuleNodeInput {
  /** Client-chosen, version-scoped reference (see schema.prisma's RuleNode comment) — not a DB row id. */
  key: string;
  /** The exact same ConditionNode AST as Rule.conditions — reused verbatim, see modules/rules/conditions.ts. */
  conditions: ConditionNode;
  onTrue: BranchTarget;
  onFalse: BranchTarget;
}

export interface RuleGraphInput {
  name: string;
  rootNodeKey: string;
  nodes: RuleNodeInput[];
}
