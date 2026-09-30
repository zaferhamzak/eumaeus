import type { ConditionNode } from "@/types/api";

function isLeaf(node: ConditionNode): node is Extract<ConditionNode, { field: string }> {
  return "field" in node;
}

function formatValue(value: ConditionNode extends never ? never : unknown): string {
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  return String(value);
}

/** A readable, indentation-free inline rendering of a condition tree — used in list rows (§16's "condition summary") and as the read view inside the detail card. */
export function conditionToText(node: ConditionNode): string {
  if (isLeaf(node)) {
    return `${node.field} ${node.op} ${formatValue(node.value)}`;
  }
  if (node.op === "NOT") {
    return `NOT (${conditionToText(node.child)})`;
  }
  return `(${node.children.map(conditionToText).join(` ${node.op} `)})`;
}

export function ConditionSummary({ condition }: { condition: ConditionNode }) {
  return <code className="font-mono text-[10.5px] text-foreground-muted">{conditionToText(condition)}</code>;
}
