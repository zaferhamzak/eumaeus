import type { RoutingDecision } from "@prisma/client";

export interface RoutingDecisionResponse {
  id: string;
  tenantId: string;
  emailId: string;
  status: string;
  matchedRuleId: string | null;
  matchedRuleVersion: number | null;
  destinationRef: string | null;
  /** Set when a RuleGraph (not a flat Rule) decided the route. */
  ruleGraphId: string | null;
  ruleGraphVersion: number | null;
  /** Ordered nodes visited, each with whether its condition matched. The full per-node condition trace stays server-side (in the row) — this is the readable path. */
  graphPath: Array<{ nodeKey: string; matched: boolean }> | null;
  /** Phase 16: the allow / block list entry that decided this email. */
  senderListEntryId: string | null;
  senderListPattern: string | null;
  /** Phase 18: when a reprocess replaced this decision; null for the current one. */
  supersededAt: string | null;
  analysisResultId: string | null;
  createdAt: string;
}

export function serializeRoutingDecision(row: RoutingDecision): RoutingDecisionResponse {
  return {
    id: row.id,
    tenantId: row.tenantId,
    emailId: row.emailId,
    status: row.status,
    matchedRuleId: row.matchedRuleId,
    matchedRuleVersion: row.matchedRuleVersion,
    destinationRef: row.destinationRef,
    ruleGraphId: row.ruleGraphId,
    ruleGraphVersion: row.ruleGraphVersion,
    senderListEntryId: row.senderListEntryId,
    senderListPattern: row.senderListPattern,
    supersededAt: row.supersededAt?.toISOString() ?? null,
    graphPath: Array.isArray(row.graphPath)
      ? (row.graphPath as Array<{ nodeKey: string; matched: boolean }>).map((step) => ({ nodeKey: step.nodeKey, matched: step.matched }))
      : null,
    analysisResultId: row.analysisResultId,
    createdAt: row.createdAt.toISOString(),
  };
}
