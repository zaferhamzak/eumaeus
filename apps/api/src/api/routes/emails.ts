import type { FastifyInstance } from "fastify";
import { idParamSchema } from "../schemas/common.js";
import { getEmailQuerySchema, listEmailsQuerySchema } from "../schemas/emails.js";
import { paginationQuerySchema } from "../pagination.js";
import { listActionExecutionsForEmail } from "../services/actionExecutionService.js";
import { listAuditEventsForEmail } from "../services/auditService.js";
import { getEmailAnalysis, getEmailDetail, listEmails } from "../services/emailService.js";
import { getRoutingDecisionForEmail } from "../services/routingDecisionService.js";
import { requirePermission } from "../plugins/requirePermission.js";

export function registerEmailRoutes(app: FastifyInstance): void {
  app.get("/api/v1/emails", { preHandler: requirePermission("emails:read") }, async (request) => {
    const query = listEmailsQuerySchema.parse(request.query);
    return listEmails(request.tenantId, query);
  });

  app.get("/api/v1/emails/:id", { preHandler: requirePermission("emails:read") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    const query = getEmailQuerySchema.parse(request.query);
    return getEmailDetail(request.tenantId, params.id, query.includeBody === "true");
  });

  app.get("/api/v1/emails/:id/analysis", { preHandler: requirePermission("emails:read") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    return getEmailAnalysis(request.tenantId, params.id);
  });

  app.get("/api/v1/emails/:id/routing", { preHandler: requirePermission("emails:read") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    return getRoutingDecisionForEmail(request.tenantId, params.id);
  });

  app.get("/api/v1/emails/:id/executions", { preHandler: requirePermission("emails:read") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    const query = paginationQuerySchema.strict().parse(request.query);
    return listActionExecutionsForEmail(request.tenantId, params.id, query);
  });

  app.get("/api/v1/emails/:id/audit", { preHandler: requirePermission("emails:read") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    const query = paginationQuerySchema.strict().parse(request.query);
    return listAuditEventsForEmail(request.tenantId, params.id, query);
  });
}
