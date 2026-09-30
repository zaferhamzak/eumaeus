import type { Prisma } from "@prisma/client";
import type { ConditionNode } from "../../modules/rules/conditions.js";
import { prisma } from "../../db/client.js";
import {
  createRule as domainCreateRule,
  updateRule as domainUpdateRule,
  getRuleById,
  deactivateRule as domainDeactivateRule,
  RuleValidationError,
} from "../../modules/rules/manageRules.js";
import { NotFoundError, ValidationError } from "../errors/ApiError.js";
import { paginateByCursor, type CursorPage, type PaginationQuery } from "../pagination.js";
import { serializeRule, type RuleResponse } from "../serializers/ruleSerializer.js";
import { ruleMatchStats } from "../../modules/rules/ruleStats.js";
import type { RuleInputBody } from "../schemas/rules.js";

export interface ListRulesQuery extends PaginationQuery {
  enabled?: "true" | "false";
}

export async function listRules(tenantId: string, query: ListRulesQuery): Promise<CursorPage<RuleResponse>> {
  const where: Prisma.RuleWhereInput = { tenantId };
  if (query.enabled !== undefined) where.enabled = query.enabled === "true";

  const page = await paginateByCursor(query, ({ cursorId, take }) =>
    prisma.rule.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take,
    }),
  );
  const stats = await ruleMatchStats(page.data.map((r) => r.id));
  return { ...page, data: page.data.map((r) => serializeRule(r, stats.get(r.id))) };
}

export async function getRule(tenantId: string, id: string): Promise<RuleResponse> {
  const rule = await getRuleById(tenantId, id);
  if (!rule) throw new NotFoundError(`Rule ${id} not found`);
  return serializeRule(rule, (await ruleMatchStats([rule.id])).get(rule.id));
}

export async function createRule(tenantId: string, input: RuleInputBody): Promise<RuleResponse> {
  try {
    const rule = await domainCreateRule(tenantId, { ...input, conditions: input.conditions as unknown as ConditionNode });
    return serializeRule(rule);
  } catch (error) {
    if (error instanceof RuleValidationError) throw new ValidationError(error.message, error.errors);
    throw error;
  }
}

/**
 * Tenant ownership is verified HERE, before calling the domain updateRule() —
 * that function looks a rule up by id alone (findUniqueOrThrow), trusted so far
 * only because every existing caller (tests, future rule-builder UI) already
 * resolved the rule through a tenant-scoped path first. The API is the first
 * caller that accepts an arbitrary externally-supplied id, so this check is
 * what actually prevents one tenant from editing another tenant's rule by id.
 */
export async function updateRule(tenantId: string, id: string, input: RuleInputBody): Promise<RuleResponse> {
  const existing = await getRuleById(tenantId, id);
  if (!existing) throw new NotFoundError(`Rule ${id} not found`);

  try {
    const updated = await domainUpdateRule(id, { ...input, conditions: input.conditions as unknown as ConditionNode });
    return serializeRule(updated);
  } catch (error) {
    if (error instanceof RuleValidationError) throw new ValidationError(error.message, error.errors);
    throw error;
  }
}

export async function deactivateRule(tenantId: string, id: string): Promise<RuleResponse> {
  const updated = await domainDeactivateRule(tenantId, id);
  if (!updated) throw new NotFoundError(`Rule ${id} not found`);
  return serializeRule(updated);
}
