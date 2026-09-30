import type { FastifyInstance } from "fastify";
import { idParamSchema } from "../schemas/common.js";
import { listActionExecutionsQuerySchema } from "../schemas/actionExecutions.js";
import { getActionExecutionById, listActionExecutions, retryActionExecution, undoActionExecution } from "../services/actionExecutionService.js";
import { requirePermission } from "../plugins/requirePermission.js";

export function registerActionExecutionRoutes(app: FastifyInstance): void {
  app.get("/api/v1/action-executions", { preHandler: requirePermission("action_executions:read") }, async (request) => {
    const query = listActionExecutionsQuerySchema.parse(request.query);
    return listActionExecutions(request.tenantId, query);
  });

  app.get("/api/v1/action-executions/:id", { preHandler: requirePermission("action_executions:read") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    return getActionExecutionById(request.tenantId, params.id);
  });

  // §22: only re-triggers the EXISTING BullMQ job via Job.retry() — never calls
  // an executor directly, never creates a new logical execution. See
  // modules/destinations/retryActionExecution.ts.
  app.post("/api/v1/action-executions/:id/retry", { preHandler: requirePermission("action_executions:retry") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    return retryActionExecution(request.tenantId, params.id);
  });

  // Phase 15: moves an archived message back to its original folder, over
  // IMAP, right now (not queued — the person is waiting for the answer).
  app.post("/api/v1/action-executions/:id/undo", { preHandler: requirePermission("action_executions:undo") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    return undoActionExecution(request.tenantId, params.id, request.user?.email ?? "system");
  });
}
