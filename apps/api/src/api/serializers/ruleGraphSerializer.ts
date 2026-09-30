import type { RuleGraph, RuleNode } from "@prisma/client";
import type { RuleGraphWithNodes } from "../../modules/rule-graphs/manageRuleGraphs.js";

export interface RuleNodeResponse {
  id: string;
  key: string;
  conditions: unknown;
  onTrue: unknown;
  onFalse: unknown;
}

/** `tenantId` is exposed as `organizationId` — Phase 10's public API name for the same underlying row (see schema.prisma's Tenant header comment). */
export interface RuleGraphResponse {
  id: string;
  organizationId: string;
  name: string;
  enabled: boolean;
  version: number;
  rootNodeKey: string;
  nodes: RuleNodeResponse[];
  createdAt: string;
  updatedAt: string;
  versionCreatedAt: string;
}

export interface RuleGraphSummaryResponse {
  id: string;
  organizationId: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

function serializeNode(row: RuleNode): RuleNodeResponse {
  return { id: row.id, key: row.key, conditions: row.conditions, onTrue: row.onTrue, onFalse: row.onFalse };
}

export function serializeRuleGraph({ graph, version, nodes }: RuleGraphWithNodes): RuleGraphResponse {
  return {
    id: graph.id,
    organizationId: graph.tenantId,
    name: graph.name,
    enabled: graph.enabled,
    version: version.version,
    rootNodeKey: version.rootNodeKey,
    nodes: nodes.map(serializeNode),
    createdAt: graph.createdAt.toISOString(),
    updatedAt: graph.updatedAt.toISOString(),
    versionCreatedAt: version.createdAt.toISOString(),
  };
}

export function serializeRuleGraphSummary(row: RuleGraph): RuleGraphSummaryResponse {
  return {
    id: row.id,
    organizationId: row.tenantId,
    name: row.name,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
