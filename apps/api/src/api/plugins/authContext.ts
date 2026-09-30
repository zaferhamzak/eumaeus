import type { FastifyInstance, FastifyRequest } from "fastify";
import { prisma } from "../../db/client.js";
import { loadEnv } from "../../config/env.js";
import { readSession, refreshSession } from "../../modules/auth/sessionStore.js";
import { resolveApiKey } from "../../modules/auth/apiKeys.js";

/**
 * Resolves WHO is making a request — the counterpart to tenantContext.ts's
 * "which organization." Registered at the TOP LEVEL of api/server.ts (before
 * the tenant-scoped child), so `request.user` is populated even for routes
 * with no tenant concept at all (/api/v1/auth/*, /api/v1/organizations list/create,
 * health/metrics). Unlike tenantContext, this plugin NEVER throws — being
 * unauthenticated is a perfectly valid state for a public route; routes that
 * actually require auth reject a null request.user themselves
 * (tenantContext.ts's rewrite, requirePermission.ts).
 */
declare module "fastify" {
  interface FastifyRequest {
    user: AuthenticatedUser | null;
  }
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  isSuperAdmin: boolean;
  /** Phase 20: set when the caller authenticated with an API key instead of a session. */
  apiKey?: { id: string; tenantId: string; permissions: string[] };
}

export type AuthResolver = (request: FastifyRequest) => Promise<AuthenticatedUser | null>;

/**
 * Reads the session cookie, looks it up in Redis, loads the User row —
 * returns null (never throws) for: no cookie, no matching Redis session, or
 * a User row that no longer exists / is disabled. A disabled account's
 * existing session cookie is therefore inert immediately, not just on next
 * login — status is checked on every request, not cached in the session.
 */
export const defaultAuthResolver: AuthResolver = async (request) => {
  // Phase 20: "Authorization: Bearer jm_…" — an API key. Never for the
  // session/account routes (/auth/*): a key is not a person.
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    if ((request.url.split("?")[0] ?? "").startsWith("/api/v1/auth/")) return null;
    const apiKey = await resolveApiKey(authorization.slice("Bearer ".length).trim());
    if (!apiKey) return null;
    return {
      id: `api-key:${apiKey.id}`,
      email: `api-key:${apiKey.name} (${apiKey.prefix})`,
      isSuperAdmin: false,
      apiKey: { id: apiKey.id, tenantId: apiKey.tenantId, permissions: apiKey.permissions },
    };
  }

  const env = loadEnv();
  const token = request.cookies[env.SESSION_COOKIE_NAME];
  if (!token) return null;

  const session = await readSession(token);
  if (!session) return null;

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user || user.status !== "active") return null;

  await refreshSession(token, session);
  return { id: user.id, email: user.email, isSuperAdmin: user.isSuperAdmin };
};

export function registerAuthContextPlugin(app: FastifyInstance, resolver: AuthResolver = defaultAuthResolver): void {
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (request) => {
    request.user = await resolver(request);
  });
}
