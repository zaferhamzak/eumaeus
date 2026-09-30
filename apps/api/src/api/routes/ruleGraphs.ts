import type { FastifyInstance } from "fastify";
import { idParamSchema } from "../schemas/common.js";
import { listRuleGraphsQuerySchema, ruleGraphInputBodySchema } from "../schemas/ruleGraphs.js";
import { createRuleGraph, getRuleGraph, listRuleGraphs, setRuleGraphEnabled, updateRuleGraph, validateRuleGraphStructure } from "../services/ruleGraphService.js";
import { z } from "zod";
import { requirePermission } from "../plugins/requirePermission.js";

/**
 * The Rule Graph API: create/retrieve/update-as-new-version/validate, plus enable/disable
 * (Phase 12 — a graph assigned to a mailbox routes that mailbox's email
 * live while enabled; see modules/rules/evaluateRulesForEmail.ts).
 */
export function registerRuleGraphRoutes(app: FastifyInstance): void {
  app.get("/api/v1/rule-graphs", { preHandler: requirePermission("rule_graphs:read") }, async (request) => {
    const query = listRuleGraphsQuerySchema.parse(request.query);
    return listRuleGraphs(request.tenantId, query);
  });

  app.get("/api/v1/rule-graphs/:id", { preHandler: requirePermission("rule_graphs:read") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    return getRuleGraph(request.tenantId, params.id);
  });

  app.post("/api/v1/rule-graphs", { preHandler: requirePermission("rule_graphs:write") }, async (request, reply) => {
    const body = ruleGraphInputBodySchema.parse(request.body);
    const created = await createRuleGraph(request.tenantId, body);
    return reply.status(201).send(created);
  });

  app.patch("/api/v1/rule-graphs/:id", { preHandler: requirePermission("rule_graphs:write") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    const body = ruleGraphInputBodySchema.parse(request.body);
    return updateRuleGraph(request.tenantId, params.id, body);
  });

  app.put("/api/v1/rule-graphs/:id/enabled", { preHandler: requirePermission("rule_graphs:write") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    const body = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    return setRuleGraphEnabled(request.tenantId, params.id, body.enabled, request.user?.email);
  });

  // Structural validation only — never persists. Useful for a future graph
  // editor to check-before-save, and exercised directly by tests here.
  app.post("/api/v1/rule-graphs/validate", { preHandler: requirePermission("rule_graphs:read") }, async (request) => {
    const body = ruleGraphInputBodySchema.parse(request.body);
    return validateRuleGraphStructure(request.tenantId, body);
  });
}
