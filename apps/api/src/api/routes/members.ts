import type { FastifyInstance } from "fastify";
import { idAndMembershipIdParamSchema, idParamSchema } from "../schemas/common.js";
import { inviteMemberBodySchema, updateMemberBodySchema } from "../schemas/members.js";
import { inviteMember, listMembers, revokeMember, updateMember } from "../services/memberService.js";
import { requirePermission } from "../plugins/requirePermission.js";

/**
 * Registered inside the tenant-scoped child (drain guard / rate limit
 * apply), but every permission check here uses requirePermission's
 * `{ paramName: "id" }` mode — the target organization is the URL param
 * (`:id`), same as organizations.ts's own `:id` routes, never
 * request.tenantId/request.membership (which would be the HEADER's org,
 * possibly a different one than the URL names).
 */
export function registerMemberRoutes(app: FastifyInstance): void {
  app.get("/api/v1/organizations/:id/members", { preHandler: requirePermission("members:read", { paramName: "id" }) }, async (request) => {
    const params = idParamSchema.parse(request.params);
    return listMembers(params.id);
  });

  app.post("/api/v1/organizations/:id/members", { preHandler: requirePermission("members:invite", { paramName: "id" }) }, async (request, reply) => {
    const params = idParamSchema.parse(request.params);
    const body = inviteMemberBodySchema.parse(request.body);
    const result = await inviteMember(params.id, body);
    return reply.status(201).send(result);
  });

  app.patch(
    "/api/v1/organizations/:id/members/:membershipId",
    { preHandler: requirePermission("members:manage", { paramName: "id" }) },
    async (request) => {
      const params = idAndMembershipIdParamSchema.parse(request.params);
      const body = updateMemberBodySchema.parse(request.body);
      return updateMember(params.id, params.membershipId, body);
    },
  );

  app.delete(
    "/api/v1/organizations/:id/members/:membershipId",
    { preHandler: requirePermission("members:manage", { paramName: "id" }) },
    async (request, reply) => {
      const params = idAndMembershipIdParamSchema.parse(request.params);
      await revokeMember(params.id, params.membershipId);
      return reply.status(204).send();
    },
  );
}
