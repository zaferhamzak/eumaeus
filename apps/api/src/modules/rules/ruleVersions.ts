import type { Rule } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { recordAuditEvent, AuditEventType } from "../audit/record.js";
import { restoreRule, updateRule } from "./manageRules.js";
import { assessRuleChange, type RuleImpact } from "./ruleImpact.js";
import type { ConditionNode } from "./conditions.js";

/**
 * Phase 25: a rule's history and going back to an earlier version. Nothing is
 * ever rewritten: going back saves the chosen version's content as a NEW
 * version (so the history reads "v5 = back to v2"), and a deleted rule is
 * restored as a new version of the same lineage. Both pass the rule impact
 * check first — a revert that would send business mail to junk needs the same
 * confirmation as any other change.
 */
export interface RuleVersionView {
  id: string;
  version: number;
  name: string;
  priority: number;
  destinationRef: string;
  conditions: unknown;
  createdAt: string;
  deactivatedAt: string | null;
  active: boolean;
  /** Emails this exact version matched while it was live. */
  matches: number;
}

export class RuleVersionError extends Error {
  constructor(
    public readonly code: "not_found" | "same_as_current" | "priority_taken" | "risky",
    message: string,
    public readonly impact?: RuleImpact,
  ) {
    super(message);
  }
}

async function lineageRows(tenantId: string, ruleId: string): Promise<{ lineageId: string; rows: Rule[] }> {
  const rule = await prisma.rule.findFirst({ where: { id: ruleId, tenantId } });
  if (!rule) throw new RuleVersionError("not_found", `Rule ${ruleId} not found`);
  const lineageId = rule.lineageId ?? rule.id;
  const rows = await prisma.rule.findMany({ where: { tenantId, OR: [{ lineageId }, { id: lineageId }] }, orderBy: [{ version: "asc" }, { createdAt: "asc" }] });
  return { lineageId, rows };
}

export async function listRuleVersions(tenantId: string, ruleId: string): Promise<RuleVersionView[]> {
  const { rows } = await lineageRows(tenantId, ruleId);
  const counts = await prisma.ruleEvaluation.groupBy({ by: ["ruleId"], where: { ruleId: { in: rows.map((r) => r.id) }, matched: true }, _count: { _all: true } });
  const matchesBy = new Map(counts.map((c) => [c.ruleId, c._count._all]));
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    name: r.name,
    priority: r.priority,
    destinationRef: r.destinationRef,
    conditions: r.conditions,
    createdAt: r.createdAt.toISOString(),
    deactivatedAt: r.deactivatedAt?.toISOString() ?? null,
    active: r.enabled && r.deactivatedAt === null,
    matches: matchesBy.get(r.id) ?? 0,
  }));
}

const same = (a: Rule, b: Rule) =>
  a.name === b.name && a.priority === b.priority && a.destinationRef === b.destinationRef && JSON.stringify(a.conditions) === JSON.stringify(b.conditions);

/** Goes back to `version` (or restores the rule with it when the rule was deleted). Returns the new active version. */
export async function revertRule(tenantId: string, ruleId: string, version: number, actor: string, options: { confirmImpact?: boolean; priority?: number } = {}): Promise<{ rule: Rule; restored: boolean; impact: RuleImpact }> {
  const { lineageId, rows } = await lineageRows(tenantId, ruleId);
  const target = rows.find((r) => r.version === version);
  if (!target) throw new RuleVersionError("not_found", `This rule has no version ${version}.`);
  const active = rows.find((r) => r.enabled && r.deactivatedAt === null);
  if (active && same(active, target)) throw new RuleVersionError("same_as_current", `The rule is already the same as version ${version}.`);

  const input = { name: target.name, priority: options.priority ?? target.priority, destinationRef: target.destinationRef, conditions: target.conditions as unknown as ConditionNode };
  if (!active) {
    const clash = await prisma.rule.findFirst({ where: { tenantId, priority: input.priority, enabled: true, deactivatedAt: null } });
    if (clash) throw new RuleVersionError("priority_taken", `Priority ${input.priority} is now used by rule "${clash.name}". Choose another priority to restore this rule.`);
  }

  const impact = await assessRuleChange(tenantId, active ? { type: "update", ruleId: active.id, rule: input } : { type: "create", rule: input });
  if (impact.risky.count > 0 && !options.confirmImpact) {
    throw new RuleVersionError("risky", `Going back would move ${impact.risky.count} email(s) that look like business mail to a junk-like destination. Confirm to do it anyway.`, impact);
  }

  const rule = active ? await updateRule(active.id, input) : await restoreRule(tenantId, lineageId, input);
  await recordAuditEvent(prisma, {
    tenantId,
    eventType: AuditEventType.RULE_REVERTED,
    actor,
    payload: { lineageId, fromVersion: active?.version ?? null, toContentOf: version, newRuleId: rule.id, newVersion: rule.version, restored: !active },
  });
  return { rule, restored: !active, impact };
}
