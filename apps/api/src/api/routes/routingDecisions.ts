import type { FastifyInstance } from "fastify";
import { idParamSchema } from "../schemas/common.js";
import { paginationQuerySchema } from "../pagination.js";
import { getRoutingDecisionById, listRoutingDecisions } from "../services/routingDecisionService.js";
import { requirePermission } from "../plugins/requirePermission.js";

export function registerRoutingDecisionRoutes(app: FastifyInstance): void {
  app.get("/api/v1/routing-decisions", { preHandler: requirePermission("routing_decisions:read") }, async (request) => {
    const query = paginationQuerySchema.strict().parse(request.query);
    return listRoutingDecisions(request.tenantId, query);
  });

  app.get("/api/v1/routing-decisions/:id", { preHandler: requirePermission("routing_decisions:read") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    return getRoutingDecisionById(request.tenantId, params.id);
  });
}
