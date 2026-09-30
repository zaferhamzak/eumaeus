import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission } from "../plugins/requirePermission.js";
import { ValidationError } from "../errors/ApiError.js";
import { ruleInputBodySchema } from "../schemas/rules.js";
import { ruleGraphInputBodySchema } from "../schemas/ruleGraphs.js";
import { MAX_SIMULATION_EMAILS, simulateRouting, SimulationValidationError, type SimulationTarget } from "../../modules/rules/simulateRouting.js";
import type { ConditionNode } from "../../modules/rules/conditions.js";
import type { RuleGraphInput } from "../../modules/rule-graphs/types.js";

const simulationBodySchema = z
  .object({
    target: z.discriminatedUnion("type", [
      z.object({ type: z.literal("rule"), rule: ruleInputBodySchema, replaceRuleId: z.string().min(1).max(200).optional() }).strict(),
      z.object({ type: z.literal("graph"), graph: ruleGraphInputBodySchema }).strict(),
      z.object({ type: z.literal("current") }).strict(),
      z.object({ type: z.literal("sender_entry"), entry: z.object({ kind: z.enum(["allow", "block"]), pattern: z.string().min(1).max(320) }).strict() }).strict(),
    ]),
    scope: z
      .object({
        emailIds: z.array(z.string().min(1).max(200)).max(100).optional(),
        mailboxConnectionIds: z.array(z.string().min(1).max(200)).max(50).optional(),
        since: z.string().datetime().optional(),
        until: z.string().datetime().optional(),
        limit: z.number().int().min(1).max(MAX_SIMULATION_EMAILS).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Phase 14 "try it on past emails". Read-only — it reads rules and emails
 * and writes nothing, so it needs read access to both and nothing more.
 */
export function registerSimulationRoutes(app: FastifyInstance): void {
  app.post("/api/v1/simulations", { preHandler: [requirePermission("rules:read"), requirePermission("emails:read")] }, async (request) => {
    const body = simulationBodySchema.parse(request.body);
    const target: SimulationTarget =
      body.target.type === "rule"
        ? { type: "rule", rule: { ...body.target.rule, conditions: body.target.rule.conditions as unknown as ConditionNode }, replaceRuleId: body.target.replaceRuleId }
        : body.target.type === "graph"
          ? { type: "graph", graph: body.target.graph as unknown as RuleGraphInput }
          : body.target.type === "current"
            ? { type: "current" }
            : { type: "sender_entry", entry: body.target.entry };
    try {
      return await simulateRouting(request.tenantId, target, {
        emailIds: body.scope?.emailIds,
        mailboxConnectionIds: body.scope?.mailboxConnectionIds,
        since: body.scope?.since ? new Date(body.scope.since) : undefined,
        until: body.scope?.until ? new Date(body.scope.until) : undefined,
        limit: body.scope?.limit,
      });
    } catch (error) {
      if (error instanceof SimulationValidationError) throw new ValidationError(error.message, error.errors);
      throw error;
    }
  });
}
