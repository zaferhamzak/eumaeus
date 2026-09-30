import type { Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";
import {
  createRuleGraph as domainCreateRuleGraph,
  updateRuleGraph as domainUpdateRuleGraph,
  getRuleGraphById,
  RuleGraphValidationError,
} from "../../modules/rule-graphs/manageRuleGraphs.js";
import { validateRuleGraph } from "../../modules/rule-graphs/graphValidation.js";
import type { RuleGraphInput } from "../../modules/rule-graphs/types.js";
import type { ConditionNode } from "../../modules/rules/conditions.js";
import { NotFoundError, ValidationError } from "../errors/ApiError.js";
import { recordAuditEvent, AuditEventType } from "../../modules/audit/record.js";
import { paginateByCursor, type CursorPage, type PaginationQuery } from "../pagination.js";
import {
  serializeRuleGraph,
  serializeRuleGraphSummary,
  type RuleGraphResponse,
  type RuleGraphSummaryResponse,
} from "../serializers/ruleGraphSerializer.js";
import type { RuleGraphInputBody } from "../schemas/ruleGraphs.js";
import { customFieldTypes } from "../../modules/rules/customFields.js";

function toDomainInput(body: RuleGraphInputBody): RuleGraphInput {
  return {
    name: body.name,
    rootNodeKey: body.rootNodeKey,
    nodes: body.nodes.map((node) => ({
      key: node.key,
      conditions: node.conditions as unknown as ConditionNode,
      onTrue: node.onTrue,
      onFalse: node.onFalse,
    })),
  };
}

export async function listRuleGraphs(tenantId: string, query: PaginationQuery): Promise<CursorPage<RuleGraphSummaryResponse>> {
  const where: Prisma.RuleGraphWhereInput = { tenantId };

  const page = await paginateByCursor(query, ({ cursorId, take }) =>
    prisma.ruleGraph.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take,
    }),
  );
  return { ...page, data: page.data.map(serializeRuleGraphSummary) };
}

export async function getRuleGraph(tenantId: string, id: string): Promise<RuleGraphResponse> {
  const result = await getRuleGraphById(tenantId, id);
  if (!result) throw new NotFoundError(`Rule graph ${id} not found`);
  return serializeRuleGraph(result);
}

export async function createRuleGraph(tenantId: string, body: RuleGraphInputBody): Promise<RuleGraphResponse> {
  try {
    const result = await domainCreateRuleGraph(tenantId, toDomainInput(body));
    return serializeRuleGraph(result);
  } catch (error) {
    if (error instanceof RuleGraphValidationError) throw new ValidationError(error.message, error.errors);
    throw error;
  }
}

/**
 * Tenant ownership is verified HERE, before calling the domain
 * updateRuleGraph() — same reasoning as ruleService.ts's updateRule(): the
 * domain function trusts the id it's given, so the API layer (the first
 * caller accepting an arbitrary externally-supplied id) is what actually
 * prevents one tenant from editing another tenant's graph by id.
 */
export async function updateRuleGraph(tenantId: string, id: string, body: RuleGraphInputBody): Promise<RuleGraphResponse> {
  const existing = await getRuleGraphById(tenantId, id);
  if (!existing) throw new NotFoundError(`Rule graph ${id} not found`);

  try {
    const result = await domainUpdateRuleGraph(id, toDomainInput(body));
    return serializeRuleGraph(result);
  } catch (error) {
    if (error instanceof RuleGraphValidationError) throw new ValidationError(error.message, error.errors);
    throw error;
  }
}

export interface ValidateRuleGraphResponse {
  valid: boolean;
  errors: string[];
}

/** Structural validation only — the SAME validator create/update run internally, exposed standalone so a graph can be checked before it's ever saved. Never persists anything. */
export async function validateRuleGraphStructure(tenantId: string, body: RuleGraphInputBody): Promise<ValidateRuleGraphResponse> {
  const errors = validateRuleGraph(toDomainInput(body), await customFieldTypes(tenantId));
  return { valid: errors.length === 0, errors };
}

/**
 * Turning a graph off is how an admin takes it out of live routing without
 * unassigning it from every mailbox: a disabled graph makes its mailboxes
 * fall back to the flat rules (see evaluateRulesForEmail.ts). Not a new
 * version — enabled is a property of the graph, not of its node structure.
 */
export async function setRuleGraphEnabled(tenantId: string, id: string, enabled: boolean, actor?: string): Promise<RuleGraphResponse> {
  const graph = await prisma.ruleGraph.findFirst({ where: { id, tenantId } });
  if (!graph) throw new NotFoundError(`Rule graph ${id} not found`);
  await prisma.ruleGraph.update({ where: { id }, data: { enabled } });
  await recordAuditEvent(prisma, {
    tenantId,
    eventType: enabled ? AuditEventType.RULE_GRAPH_ENABLED : AuditEventType.RULE_GRAPH_DISABLED,
    actor: actor ?? "system",
    payload: { ruleGraphId: id },
  });
  return getRuleGraph(tenantId, id);
}
