import type { Rule } from "@prisma/client";
import type { RuleMatchStats } from "../../modules/rules/ruleStats.js";

export interface RuleResponse {
  id: string;
  tenantId: string;
  name: string;
  priority: number;
  enabled: boolean;
  version: number;
  conditions: unknown;
  destinationRef: string;
  createdAt: string;
  updatedAt: string;
  deactivatedAt: string | null;
  /** Phase 14: counted since this version of the rule was saved. */
  stats?: { matchesLast7Days: number; matchesLast30Days: number; evaluationsLast30Days: number; lastMatchedAt: string | null };
}

export function serializeRule(row: Rule, stats?: RuleMatchStats): RuleResponse {
  return {
    ...(stats ? { stats: { ...stats, lastMatchedAt: stats.lastMatchedAt?.toISOString() ?? null } } : {}),
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    priority: row.priority,
    enabled: row.enabled,
    version: row.version,
    conditions: row.conditions,
    destinationRef: row.destinationRef,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
  };
}
