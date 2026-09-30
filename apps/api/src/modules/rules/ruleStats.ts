import { prisma } from "../../db/client.js";

/**
 * Match statistics per rule (Phase 14), from the RuleEvaluation rows the
 * live engine writes. Counted per rule ROW: an edit creates a new row
 * (a new version), so a rule's numbers start again from that edit — "how
 * does the rule as it is now behave", not a mix of old and new conditions.
 */
export interface RuleMatchStats {
  matchesLast7Days: number;
  matchesLast30Days: number;
  /** How many emails reached this rule (were evaluated against it) in 30 days. */
  evaluationsLast30Days: number;
  lastMatchedAt: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function ruleMatchStats(ruleIds: string[], now: Date = new Date()): Promise<Map<string, RuleMatchStats>> {
  const stats = new Map<string, RuleMatchStats>(ruleIds.map((id) => [id, { matchesLast7Days: 0, matchesLast30Days: 0, evaluationsLast30Days: 0, lastMatchedAt: null }]));
  if (ruleIds.length === 0) return stats;
  const since30 = new Date(now.getTime() - 30 * DAY_MS);
  const since7 = new Date(now.getTime() - 7 * DAY_MS);

  const [evaluated30, matched30, matched7, lastMatch] = await Promise.all([
    prisma.ruleEvaluation.groupBy({ by: ["ruleId"], where: { ruleId: { in: ruleIds }, evaluatedAt: { gte: since30 } }, _count: { _all: true } }),
    prisma.ruleEvaluation.groupBy({ by: ["ruleId"], where: { ruleId: { in: ruleIds }, matched: true, evaluatedAt: { gte: since30 } }, _count: { _all: true } }),
    prisma.ruleEvaluation.groupBy({ by: ["ruleId"], where: { ruleId: { in: ruleIds }, matched: true, evaluatedAt: { gte: since7 } }, _count: { _all: true } }),
    prisma.ruleEvaluation.groupBy({ by: ["ruleId"], where: { ruleId: { in: ruleIds }, matched: true }, _max: { evaluatedAt: true } }),
  ]);
  for (const row of evaluated30) stats.get(row.ruleId)!.evaluationsLast30Days = row._count._all;
  for (const row of matched30) stats.get(row.ruleId)!.matchesLast30Days = row._count._all;
  for (const row of matched7) stats.get(row.ruleId)!.matchesLast7Days = row._count._all;
  for (const row of lastMatch) stats.get(row.ruleId)!.lastMatchedAt = row._max.evaluatedAt;
  return stats;
}
