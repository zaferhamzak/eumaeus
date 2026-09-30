import type { FastifyInstance } from "fastify";
import { idParamSchema } from "../schemas/common.js";
import { z } from "zod";
import {
  listRulesQuerySchema,
  ruleImpactBodySchema,
  ruleImportBodySchema,
  ruleSaveBodySchema,
} from "../schemas/rules.js";
import { assessRuleChange, RuleImpactError, type RuleChange } from "../../modules/rules/ruleImpact.js";
import { listRuleVersions, revertRule, RuleVersionError } from "../../modules/rules/ruleVersions.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors/ApiError.js";
import { exportRules, importRules } from "../../modules/rules/ruleTransfer.js";
import type { ConditionNode } from "../../modules/rules/conditions.js";
import {
  createRule,
  deactivateRule,
  getRule,
  listRules,
  updateRule,
} from "../services/ruleService.js";
import { requirePermission } from "../plugins/requirePermission.js";

export function registerRuleRoutes(app: FastifyInstance): void {
  app.get(
    "/api/v1/rules",
    { preHandler: requirePermission("rules:read") },
    async (request) => {
      const query = listRulesQuerySchema.parse(request.query);
      return listRules(request.tenantId, query);
    },
  );

  // Rule sets as JSON (Phase 19): download the active rules, or load a file.
  app.get(
    "/api/v1/rules/export",
    { preHandler: requirePermission("rules:read") },
    async (request) => exportRules(request.tenantId),
  );

  app.post(
    "/api/v1/rules/import",
    // Replacing deactivates the current rules, so it also needs rules:delete.
    {
      bodyLimit: 2 * 1024 * 1024,
      preHandler: [
        requirePermission("rules:write"),
        async (request) => {
          if (
            (request.body as { mode?: unknown } | undefined)?.mode === "replace"
          )
            await requirePermission("rules:delete")(request);
        },
      ],
    },
    async (request) => {
      const body = ruleImportBodySchema.parse(request.body);
      const rules = body.rules.map((r) => ({
        ...r,
        conditions: r.conditions as unknown as ConditionNode,
      }));
      return importRules(
        request.tenantId,
        rules,
        { mode: body.mode, priorities: body.priorities, dryRun: body.dryRun },
        request.user?.email,
      );
    },
  );

  // What a rule change would do to recent mail, without saving it.
  app.post(
    "/api/v1/rules/impact",
    { preHandler: requirePermission("rules:read") },
    async (request) => {
      const body = ruleImpactBodySchema.parse(request.body);
      return runImpact(request.tenantId, body.change as RuleChange, body.days);
    },
  );

  // Phase 25: a rule's version history, and going back to a version.
  app.get(
    "/api/v1/rules/:id/versions",
    { preHandler: requirePermission("rules:read") },
    async (request) => {
      const params = idParamSchema.parse(request.params);
      try {
        return { data: await listRuleVersions(request.tenantId, params.id) };
      } catch (error) {
        if (error instanceof RuleVersionError && error.code === "not_found") throw new NotFoundError(error.message);
        throw error;
      }
    },
  );

  app.post(
    "/api/v1/rules/:id/revert",
    { preHandler: requirePermission("rules:write") },
    async (request) => {
      const params = idParamSchema.parse(request.params);
      const body = revertBodySchema.parse(request.body);
      try {
        const result = await revertRule(request.tenantId, params.id, body.version, request.user?.email ?? "system", { confirmImpact: body.confirmImpact, priority: body.priority });
        return { rule: await getRule(request.tenantId, result.rule.id), restored: result.restored, impact: result.impact };
      } catch (error) {
        if (error instanceof RuleVersionError) {
          if (error.code === "not_found") throw new NotFoundError(error.message);
          throw new ConflictError(error.message, error.impact ? { impact: error.impact } : undefined);
        }
        throw error;
      }
    },
  );

  app.get(
    "/api/v1/rules/:id",
    { preHandler: requirePermission("rules:read") },
    async (request) => {
      const params = idParamSchema.parse(request.params);
      return getRule(request.tenantId, params.id);
    },
  );

  app.post(
    "/api/v1/rules",
    { preHandler: requirePermission("rules:write") },
    async (request, reply) => {
      const { confirmImpact, ...rule } = ruleSaveBodySchema.parse(request.body);
      await guardImpact(request.tenantId, { type: "create", rule: toRuleInput(rule) }, confirmImpact);
      const created = await createRule(request.tenantId, rule);
      return reply.status(201).send(created);
    },
  );

  app.patch(
    "/api/v1/rules/:id",
    { preHandler: requirePermission("rules:write") },
    async (request) => {
      const params = idParamSchema.parse(request.params);
      const { confirmImpact, ...rule } = ruleSaveBodySchema.parse(request.body);
      await guardImpact(request.tenantId, { type: "update", ruleId: params.id, rule: toRuleInput(rule) }, confirmImpact);
      return updateRule(request.tenantId, params.id, rule);
    },
  );

  app.delete(
    "/api/v1/rules/:id",
    { preHandler: requirePermission("rules:delete") },
    async (request, reply) => {
      const params = idParamSchema.parse(request.params);
      const { confirmImpact } = deleteQuerySchema.parse(request.query);
      await guardImpact(request.tenantId, { type: "delete", ruleId: params.id }, confirmImpact === "true");
      await deactivateRule(request.tenantId, params.id);
      return reply.status(204).send();
    },
  );
}

const deleteQuerySchema = z.object({ confirmImpact: z.enum(["true", "false"]).optional() }).strict();

function toRuleInput(rule: { name: string; priority: number; destinationRef: string; conditions: unknown }) {
  return { ...rule, conditions: rule.conditions as ConditionNode };
}

async function runImpact(tenantId: string, change: RuleChange, days?: number) {
  try {
    return await assessRuleChange(tenantId, change, { days });
  } catch (error) {
    if (error instanceof RuleImpactError) throw new ValidationError(error.message, error.errors);
    throw error;
  }
}

/**
 * Every rule change is checked against recent mail before it is applied. A
 * change that would send business traffic (customer, finance, security) to a
 * Junk-like destination is refused with 409 and the impact report, until it is
 * resent with confirmImpact. An invalid rule or unknown rule id is left to the
 * normal save path, which reports it the usual way.
 */
async function guardImpact(tenantId: string, change: RuleChange, confirmed: boolean | undefined): Promise<void> {
  if (confirmed) return;
  let impact;
  try {
    impact = await assessRuleChange(tenantId, change);
  } catch (error) {
    if (error instanceof RuleImpactError) return;
    throw error;
  }
  if (impact.risky.count > 0) {
    throw new ConflictError(
      `This change would move ${impact.risky.count} email(s) that look like business mail (customer, finance or security) to a junk-like destination. Review the impact and confirm to save anyway.`,
      { impact },
    );
  }
}

const revertBodySchema = z.object({ version: z.number().int().min(1), priority: z.number().int().optional(), confirmImpact: z.boolean().optional() }).strict();
