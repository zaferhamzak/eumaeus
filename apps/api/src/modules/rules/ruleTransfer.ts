import { randomUUID } from "node:crypto";
import { prisma } from "../../db/client.js";
import { recordAuditEvent, AuditEventType } from "../audit/record.js";
import type { ConditionNode } from "./conditions.js";
import { validateRule } from "./validateRule.js";
import { customFieldTypes } from "./customFields.js";

/**
 * Rule sets as JSON: export an organization's active rules to a file, import a
 * file into this (or another) organization. The file carries only what a rule
 * IS — name, priority, conditions, destination name — never ids, versions or
 * statistics, so it can move between organizations and installations.
 *
 * Import is all-or-nothing: every rule is validated first and nothing is
 * written if any rule is invalid. Destinations are referenced by name; a name
 * that doesn't exist here is a warning, not an error (you may create the
 * destination afterwards — until then matching mail goes to Human Review).
 *
 *   mode "add"      keeps the current rules and adds the imported ones
 *   mode "replace"  deactivates every current rule, then adds the imported ones
 *                   (history stays; old versions remain readable)
 *
 *   priorities "keep"    use the file's numbers; a clash with a rule that stays
 *                        active is an error
 *   priorities "append"  renumber the imported rules after the current last
 *                        one (10, 20, 30…), keeping the file's order
 */
export const RULE_EXPORT_FORMAT = "eumaeus.rules";
/** Files exported before the rename still import. */
export const LEGACY_RULE_EXPORT_FORMAT = "jevmail.rules";
export const RULE_EXPORT_VERSION = 1;
export const MAX_IMPORTED_RULES = 500;

export interface ExportedRule {
  name: string;
  priority: number;
  destinationRef: string;
  conditions: ConditionNode;
}

export interface RuleExport {
  format: typeof RULE_EXPORT_FORMAT;
  version: typeof RULE_EXPORT_VERSION;
  exportedAt: string;
  organization: string;
  destinations: string[];
  rules: ExportedRule[];
}

export async function exportRules(
  tenantId: string,
  now: Date = new Date(),
): Promise<RuleExport> {
  const [tenant, rules] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true },
    }),
    prisma.rule.findMany({
      where: { tenantId, enabled: true, deactivatedAt: null },
      orderBy: { priority: "asc" },
    }),
  ]);
  return {
    format: RULE_EXPORT_FORMAT,
    version: RULE_EXPORT_VERSION,
    exportedAt: now.toISOString(),
    organization: tenant.name,
    destinations: [...new Set(rules.map((r) => r.destinationRef))].sort(),
    rules: rules.map((r) => ({
      name: r.name,
      priority: r.priority,
      destinationRef: r.destinationRef,
      conditions: r.conditions as unknown as ConditionNode,
    })),
  };
}

export interface ImportOptions {
  mode: "add" | "replace";
  priorities: "keep" | "append";
  dryRun: boolean;
}

export interface ImportIssue {
  index: number;
  name: string;
  message: string;
}

export interface ImportResult {
  dryRun: boolean;
  valid: boolean;
  created: number;
  deactivated: number;
  rules: Array<{ name: string; priority: number; destinationRef: string }>;
  errors: ImportIssue[];
  warnings: ImportIssue[];
}

const APPEND_STEP = 10;

export async function importRules(
  tenantId: string,
  input: ExportedRule[],
  options: ImportOptions,
  actor?: string,
): Promise<ImportResult> {
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];

  const [current, destinations, extraFields] = await Promise.all([
    prisma.rule.findMany({
      where: { tenantId, enabled: true, deactivatedAt: null },
      select: { id: true, name: true, priority: true },
    }),
    prisma.destination.findMany({
      where: { tenantId },
      select: { name: true },
    }),
    customFieldTypes(tenantId),
  ]);
  const staying = options.mode === "replace" ? [] : current;
  const knownDestinations = new Set(destinations.map((d) => d.name));

  let next = Math.max(0, ...staying.map((r) => r.priority));
  const planned = [...input]
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) =>
      options.priorities === "append"
        ? a.rule.priority - b.rule.priority || a.index - b.index
        : a.index - b.index,
    )
    .map(({ rule, index }) => {
      if (options.priorities === "append")
        next = (Math.floor(next / APPEND_STEP) + 1) * APPEND_STEP;
      return {
        index,
        rule: {
          ...rule,
          priority: options.priorities === "append" ? next : rule.priority,
        },
      };
    })
    .sort((a, b) => a.index - b.index);

  const takenBy = new Map(
    staying.map((r) => [r.priority, `active rule "${r.name}"`]),
  );
  for (const { index, rule } of planned) {
    for (const message of validateRule(rule, extraFields))
      errors.push({ index, name: rule.name, message });
    const clash = takenBy.get(rule.priority);
    if (clash)
      errors.push({
        index,
        name: rule.name,
        message: `priority ${rule.priority} is already used by ${clash}`,
      });
    else takenBy.set(rule.priority, `imported rule "${rule.name}"`);
    if (
      rule.destinationRef !== "human_review" &&
      !knownDestinations.has(rule.destinationRef)
    ) {
      warnings.push({
        index,
        name: rule.name,
        message: `destination "${rule.destinationRef}" doesn't exist here yet — matching emails will go to Human Review until it does`,
      });
    }
  }

  const result: ImportResult = {
    dryRun: options.dryRun,
    valid: errors.length === 0,
    created: 0,
    deactivated: 0,
    rules: planned.map(({ rule }) => ({
      name: rule.name,
      priority: rule.priority,
      destinationRef: rule.destinationRef,
    })),
    errors,
    warnings,
  };
  if (!result.valid || options.dryRun) return result;

  await prisma.$transaction(async (tx) => {
    if (options.mode === "replace" && current.length > 0) {
      await tx.rule.updateMany({
        where: { id: { in: current.map((r) => r.id) } },
        data: { enabled: false, deactivatedAt: new Date() },
      });
    }
    await tx.rule.createMany({
      data: planned.map(({ rule }) => {
        const id = randomUUID();
        return {
          id,
          lineageId: id,
          tenantId,
          name: rule.name,
          priority: rule.priority,
          destinationRef: rule.destinationRef,
          conditions: rule.conditions as never as object,
          enabled: true,
          version: 1,
        };
      }),
    });
    await recordAuditEvent(tx, {
      tenantId,
      eventType: AuditEventType.RULES_IMPORTED,
      actor: actor ?? "system",
      payload: {
        mode: options.mode,
        priorities: options.priorities,
        created: planned.length,
        deactivated: options.mode === "replace" ? current.length : 0,
      },
    });
  });
  return {
    ...result,
    created: planned.length,
    deactivated: options.mode === "replace" ? current.length : 0,
  };
}
