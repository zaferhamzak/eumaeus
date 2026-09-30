import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Membership } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { UnauthorizedError, ValidationError, ForbiddenError } from "../errors/ApiError.js";

/**
 * THE authentication insertion point this file's own original comment
 * (Phase 6) promised: "when real auth exists, only this function needs to
 * change." Phase 11 is that change. Every service function below this layer
 * still takes `tenantId` as an explicit parameter, never a global/ambient
 * value — no route or service signature changed.
 *
 * Decorates `request.tenantId` (unchanged) and, new in Phase 11,
 * `request.membership` — the resolved Membership row (for
 * requirePermission.ts to read `.permissions`), or the literal `"ALL"` when
 * the caller is a superAdmin (who has no Membership row at all — they
 * bypass the concept entirely), or `null` for the two organizations routes
 * that have no X-Organization-Id concept (see below).
 */
declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
    membership: Membership | "ALL" | null;
  }
}

export type TenantResolver = (request: FastifyRequest) => Promise<string>;

/**
 * Routes with genuinely no X-Organization-Id concept — requiring the header
 * on these would only ever be a pointless, unused precondition (or worse,
 * block a legitimate caller who never sends one for a route that has no use
 * for it):
 *   - The ENTIRE /api/v1/organizations subtree (list, create, :id, and the
 *     :id/members/* routes) — see api/routes/organizations.ts's own header
 *     comment: "organizations are not scoped by request.tenantId at all."
 *     Every permission check on these routes uses requirePermission's
 *     `{ paramName: "id" }` mode instead, reading the URL's own :id.
 *   - /api/v1/settings — genuinely GLOBAL (not per-organization) system
 *     settings, superAdmin-gated (requireSuperAdmin), not Membership-gated.
 * Matched by URL PREFIX for /organizations (safe — nothing else is mounted
 * under that path) and by exact path for /settings — checked against the
 * raw incoming URL (not request.routeOptions.url, which — per rateLimit.ts's
 * own documented finding — is not reliably populated yet during onRequest,
 * before route matching completes).
 */
function isUnscopedRoute(request: FastifyRequest): boolean {
  const path = request.url.split("?")[0] ?? "";
  return path === "/api/v1/organizations" || path.startsWith("/api/v1/organizations/") || path === "/api/v1/settings" || path.startsWith("/api/v1/settings/") || path.startsWith("/api/v1/admin/");
}

/**
 * Login is now required for every tenant-scoped route (no more silent
 * "fall back to the first-created tenant" for an unauthenticated caller).
 * The X-Organization-Id header is now REQUIRED, not optional-with-fallback —
 * a logged-in user must explicitly say which organization they're acting
 * in; superAdmin bypasses the Membership check entirely (the "sees every
 * organization" flag from this phase's original ask), everyone else must
 * have an ACTIVE Membership in the exact organization the header names.
 */
export const defaultTenantResolver: TenantResolver = async (request) => {
  if (!request.user) throw new UnauthorizedError("Authentication required");

  // Phase 20: an API key is bound to one organization; the header is optional
  // and, if sent, must name that same organization.
  const apiKey = request.user.apiKey;
  if (apiKey) {
    if (isUnscopedRoute(request)) throw new ForbiddenError("API keys can only be used on an organization's own routes");
    const header = request.headers["x-organization-id"];
    const named = Array.isArray(header) ? header[0] : header;
    if (named && named !== apiKey.tenantId) throw new ForbiddenError("This API key belongs to a different organization");
    const now = new Date();
    request.membership = {
      id: apiKey.id,
      userId: request.user.id,
      tenantId: apiKey.tenantId,
      permissions: apiKey.permissions,
      status: "active",
      inviteTokenHash: null,
      inviteExpiresAt: null,
      invitedAt: now,
      acceptedAt: now,
      createdAt: now,
      updatedAt: now,
    } as Membership;
    return apiKey.tenantId;
  }

  if (isUnscopedRoute(request)) {
    request.membership = null;
    return "";
  }

  const headerValue = request.headers["x-organization-id"];
  const explicitOrganizationId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!explicitOrganizationId) {
    throw new ValidationError("X-Organization-Id header is required");
  }

  if (request.user.isSuperAdmin) {
    const organization = await prisma.tenant.findUnique({ where: { id: explicitOrganizationId } });
    if (!organization) {
      throw new ValidationError(`X-Organization-Id "${explicitOrganizationId}" does not reference a real organization`);
    }
    request.membership = "ALL";
    return organization.id;
  }

  const membership = await prisma.membership.findUnique({
    where: { userId_tenantId: { userId: request.user.id, tenantId: explicitOrganizationId } },
  });
  if (!membership || membership.status !== "active") {
    throw new ForbiddenError(`You do not have access to organization "${explicitOrganizationId}"`);
  }
  request.membership = membership;
  return membership.tenantId;
};

export function registerTenantContextPlugin(app: FastifyInstance, resolver: TenantResolver = defaultTenantResolver): void {
  app.decorateRequest("tenantId", "");
  app.decorateRequest("membership", null);
  app.addHook("onRequest", async (request) => {
    request.tenantId = await resolver(request);
  });
}
