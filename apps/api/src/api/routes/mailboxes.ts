import type { FastifyInstance } from "fastify";
import { idParamSchema } from "../schemas/common.js";
import { createMailboxBodySchema, listMailboxesQuerySchema, updateMailboxBodySchema } from "../schemas/mailboxes.js";
import { createMailbox, deleteMailbox, getMailboxById, listMailboxes, triggerMailboxReconciliation, updateMailbox } from "../services/mailboxService.js";
import { requirePermission } from "../plugins/requirePermission.js";

export function registerMailboxRoutes(app: FastifyInstance): void {
  app.get("/api/v1/mailboxes", { preHandler: requirePermission("mailboxes:read") }, async (request) => {
    const query = listMailboxesQuerySchema.parse(request.query);
    return listMailboxes(request.tenantId, query);
  });

  app.get("/api/v1/mailboxes/:id", { preHandler: requirePermission("mailboxes:read") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    return getMailboxById(request.tenantId, params.id);
  });

  app.post("/api/v1/mailboxes", { preHandler: requirePermission("mailboxes:write") }, async (request, reply) => {
    const body = createMailboxBodySchema.parse(request.body);
    const created = await createMailbox(body);
    return reply.status(201).send(created);
  });

  app.patch("/api/v1/mailboxes/:id", { preHandler: requirePermission("mailboxes:write") }, async (request) => {
    const params = idParamSchema.parse(request.params);
    const body = updateMailboxBodySchema.parse(request.body);
    return updateMailbox(request.tenantId, params.id, body);
  });

  // Soft — deactivates (status="disabled"), matching Rule/Destination's
  // DELETE convention (204, no body).
  app.delete("/api/v1/mailboxes/:id", { preHandler: requirePermission("mailboxes:delete") }, async (request, reply) => {
    const params = idParamSchema.parse(request.params);
    await deleteMailbox(request.tenantId, params.id);
    return reply.status(204).send();
  });

  app.post("/api/v1/mailboxes/:id/reconcile", { preHandler: requirePermission("mailboxes:reconcile") }, async (request, reply) => {
    const params = idParamSchema.parse(request.params);
    const result = await triggerMailboxReconciliation(request.tenantId, params.id);
    return reply.status(202).send({ status: "enqueued", jobId: result.jobId });
  });
}
