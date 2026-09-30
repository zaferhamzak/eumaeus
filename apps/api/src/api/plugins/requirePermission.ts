import type { FastifyRequest } from "fastify";
import { prisma } from "../../db/client.js";
import { UnauthorizedError, ForbiddenError } from "../errors/ApiError.js";
import type { Permission } from "../../modules/auth/permissions.js";

export interface RequirePermissionOptions {
  /**
   * For routes whose target organization is a URL param (e.g.
   * organizations.ts's/members.ts's `:id`) rather than the header-resolved
   * `request.tenantId` — organizations.ts's own header comment establishes
   * that its `:id` routes are NOT scoped by request.tenantId at all, so a
   * member of org A could otherwise read/edit/deactivate org B's profile
   * just by putting org B's id in the URL. This mode does its own
   * independent Membership lookup against `params[paramName]` instead.
   */
  paramName?: string;
}

/**
 * A Fastify preHandler factory — `{ preHandler: requirePermission("mailboxes:write") }`.
 * superAdmin always bypasses both modes. Default mode reads
 * `request.membership` (populated by tenantContext.ts's rewrite); the
 * `paramName` mode never trusts request.membership since the URL param may
 * name a DIFFERENT organization than the one the header resolved.
 */
/**
 * For the one action with no target Membership to check against at all —
 * organization CREATION (POST /organizations). Every other permission gate
 * checks "does the caller's Membership in the target org allow this"; there
 * is no target org yet here, so this is deliberately superAdmin-only rather
 * than part of the per-Membership PERMISSION_CATALOG.
 */
export async function requireSuperAdmin(request: FastifyRequest): Promise<void> {
  if (!request.user) throw new UnauthorizedError("Authentication required");
  if (!request.user.isSuperAdmin) throw new ForbiddenError("Only the system administrator can do this");
}

export function requirePermission(permission: Permission, options: RequirePermissionOptions = {}) {
  return async (request: FastifyRequest): Promise<void> => {
    if (!request.user) throw new UnauthorizedError("Authentication required");
    if (request.user.isSuperAdmin) return;

    if (options.paramName) {
      const targetTenantId = (request.params as Record<string, string>)[options.paramName];
      const membership = targetTenantId
        ? await prisma.membership.findUnique({
            where: { userId_tenantId: { userId: request.user.id, tenantId: targetTenantId } },
          })
        : null;
      if (!membership || membership.status !== "active" || !membership.permissions.includes(permission)) {
        throw new ForbiddenError(`Missing required permission: ${permission}`);
      }
      return;
    }

    const membership = request.membership;
    if (membership === "ALL") return; // superAdmin already returned above — kept for exhaustive narrowing
    if (!membership || membership.status !== "active" || !membership.permissions.includes(permission)) {
      throw new ForbiddenError(`Missing required permission: ${permission}`);
    }
  };
}
