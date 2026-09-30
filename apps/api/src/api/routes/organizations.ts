import type { FastifyInstance } from "fastify";
import { idParamSchema } from "../schemas/common.js";
import { paginationQuerySchema } from "../pagination.js";
import { createOrganizationBodySchema, updateOrganizationBodySchema } from "../schemas/organizations.js";
import {
  createOrganization,
  deactivateOrganization,
  getOrganization,
  listOrganizations,
  updateOrganization,
} from "../services/organizationService.js";
import { requirePermission, requireSuperAdmin } from "../plugins/requirePermission.js";
import { UnauthorizedError } from "../errors/ApiError.js";

/**
 * Organizations are not nested under anything (they're the top-level
 * boundary) and — unlike every other resource in this API — are not scoped
 * by request.tenantId at all: creating/listing/reading/updating an
 * organization is inherently not "within my current tenant." Phase 11: GET
 * (list) and PATCH/DELETE/GET (:id) permission checks therefore use
 * requirePermission's `{ paramName: "id" }` mode — checking the URL param's
 * organization, never request.tenantId/request.membership (which
 * tenantContext.ts deliberately leaves unresolved for this router's two
 * unscoped routes, GET list and POST create — see that file's
 * isUnscopedOrganizationsRoute()). Creating a new organization has no target
 * Membership to check at all, so it's superAdmin-only (requireSuperAdmin),
 * not part of the per-Membership permission catalog.
 */
export function registerOrganizationRoutes(app: FastifyInstance): void {
  // List is membership-filtered (§ organizationService.listOrganizations),
  // not permission-gated — any logged-in user may call it, they just only
  // ever see organizations they actually belong to (or all, if superAdmin).
  app.get("/api/v1/organizations", async (request) => {
    if (!request.user) throw new UnauthorizedError("Authentication required");
    const query = paginationQuerySchema.strict().parse(request.query);
    return listOrganizations({ userId: request.user.id, isSuperAdmin: request.user.isSuperAdmin }, query);
  });

  app.get("/api/v1/organizations/:id", { preHandler: requirePermission("organizations:read", { paramName: "id" }) }, async (request) => {
    const params = idParamSchema.parse(request.params);
    return getOrganization(params.id);
  });

  app.post("/api/v1/organizations", { preHandler: requireSuperAdmin }, async (request, reply) => {
    const body = createOrganizationBodySchema.parse(request.body);
    const created = await createOrganization(body, request.user?.email);
    return reply.status(201).send(created);
  });

  app.patch("/api/v1/organizations/:id", { preHandler: requirePermission("organizations:write", { paramName: "id" }) }, async (request) => {
    const params = idParamSchema.parse(request.params);
    const body = updateOrganizationBodySchema.parse(request.body);
    return updateOrganization(params.id, body, request.user?.email);
  });

  // Soft — deactivates (status="disabled"), matching Rule/Destination's
  // DELETE convention (204, no body) exactly.
  app.delete("/api/v1/organizations/:id", { preHandler: requirePermission("organizations:delete", { paramName: "id" }) }, async (request, reply) => {
    const params = idParamSchema.parse(request.params);
    await deactivateOrganization(params.id, request.user?.email);
    return reply.status(204).send();
  });
}
