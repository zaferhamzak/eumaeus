import { validateConditionTree } from "../rules/validateRule.js";
import type { ExtraFields } from "../rules/customFields.js";
import type { BranchTarget, RuleGraphInput, RuleNodeInput } from "./types.js";

/**
 * Save-time structural validation for a whole graph — mirrors
 * modules/rules/validateRule.ts's "fail loudly before persisting" role, one
 * level up: a single RuleNode's OWN condition tree is still validated by the
 * existing validateConditionTree() (reused verbatim, never duplicated); this
 * file adds the graph-shape checks a single condition tree has no concept
 * of — missing/invalid branch references, orphaned nodes, duplicate keys, an
 * invalid root, and (see walkGraph below) a cycle.
 *
 * Cycle detection is included here, not deferred to Phase 2: it falls out of
 * the same single reachability traversal orphan-detection already needs
 * (standard "currently on the DFS stack" check), so it is genuinely trivial
 * given this representation — not a dedicated service.
 */
export function validateRuleGraph(input: RuleGraphInput, extraFields: ExtraFields = {}): string[] {
  const errors: string[] = [];

  if (!input.name.trim()) errors.push("name must not be empty");

  if (input.nodes.length === 0) {
    errors.push("graph must contain at least one node");
    return errors; // nothing else can be meaningfully checked without nodes
  }

  const seenKeys = new Set<string>();
  const duplicateKeys = new Set<string>();
  for (const node of input.nodes) {
    if (seenKeys.has(node.key)) duplicateKeys.add(node.key);
    seenKeys.add(node.key);
  }
  if (duplicateKeys.size > 0) {
    errors.push(`duplicate node key(s): ${[...duplicateKeys].sort().join(", ")}`);
  }

  const nodesByKey = new Map(input.nodes.map((n) => [n.key, n]));

  const rootValid = Boolean(input.rootNodeKey) && nodesByKey.has(input.rootNodeKey);
  if (!rootValid) {
    errors.push(`rootNodeKey "${input.rootNodeKey}" does not reference a node in this graph`);
  }

  for (const node of input.nodes) {
    errors.push(...validateConditionTree(node.conditions, `nodes.${node.key}.conditions`, extraFields));
    errors.push(...validateBranchTarget(node.onTrue, `nodes.${node.key}.onTrue`, nodesByKey));
    errors.push(...validateBranchTarget(node.onFalse, `nodes.${node.key}.onFalse`, nodesByKey));
  }

  // Reachability (orphans) + cycle detection — only meaningful once the root
  // and every node key are individually sound; a broken root/duplicate keys
  // would make a traversal's result misleading rather than helpful.
  if (rootValid && duplicateKeys.size === 0) {
    const { reachable, cycleAt } = walkGraph(input.rootNodeKey, nodesByKey);
    if (cycleAt) {
      errors.push(`cycle detected in graph, involving node "${cycleAt}"`);
    }
    const orphaned = input.nodes.map((n) => n.key).filter((key) => !reachable.has(key));
    if (orphaned.length > 0) {
      errors.push(`orphaned node(s) not reachable from rootNodeKey: ${orphaned.sort().join(", ")}`);
    }
  }

  return errors;
}

function validateBranchTarget(target: BranchTarget, path: string, nodesByKey: Map<string, RuleNodeInput>): string[] {
  if (!target || typeof target !== "object" || !("type" in target)) {
    return [`${path}: malformed branch target`];
  }
  if (target.type === "node") {
    if (!target.nodeKey || !nodesByKey.has(target.nodeKey)) {
      return [`${path}: references unknown node "${String(target.nodeKey)}"`];
    }
    return [];
  }
  if (target.type === "action") {
    if (!target.destinationRef || !target.destinationRef.trim()) {
      return [`${path}: action branch requires a non-empty destinationRef`];
    }
    return [];
  }
  return [`${path}: unknown branch target type "${String((target as { type?: unknown }).type)}"`];
}

/**
 * Single DFS from the root. `reachable` answers "is this node reachable at
 * all" (orphan detection); `cycleAt` is set the first time the walk
 * re-encounters a node that is still on the current path (the classic
 * white/gray/black cycle check) — a node fully explored via one path and
 * later reached again via another is fine in a DAG and is not a cycle.
 */
function walkGraph(rootKey: string, nodesByKey: Map<string, RuleNodeInput>): { reachable: Set<string>; cycleAt: string | null } {
  const reachable = new Set<string>();
  const onStack = new Set<string>();
  let cycleAt: string | null = null;

  function visit(key: string): void {
    if (cycleAt) return;
    if (onStack.has(key)) {
      cycleAt = key;
      return;
    }
    if (reachable.has(key)) return; // already fully explored via another path

    const node = nodesByKey.get(key);
    if (!node) return; // unknown reference — already reported by validateBranchTarget

    onStack.add(key);
    reachable.add(key);
    for (const branch of [node.onTrue, node.onFalse]) {
      if (branch && branch.type === "node") visit(branch.nodeKey);
    }
    onStack.delete(key);
  }

  visit(rootKey);
  return { reachable, cycleAt };
}
