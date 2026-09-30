import type { FastifyInstance } from "fastify";
import { buildServer } from "../../../src/api/server.js";
import type { AuthResolver } from "../../../src/api/plugins/authContext.js";
import { SUPERADMIN_TEST_AUTH_RESOLVER } from "../../helpers/auth.js";

export interface BuildTestServerOptions {
  authResolver?: AuthResolver;
}

/**
 * Builds a fresh Fastify app for one test file, with the tenant resolver fixed
 * to a specific tenant id (bypassing "look up the bootstrap tenant" — most API
 * tests create their own tenant via test/helpers/db.ts and need the app to
 * resolve requests against THAT tenant, not whatever tenant happens to exist
 * first). Logging is disabled to keep test output clean.
 *
 * Phase 11: defaults to a synthetic superAdmin principal (SUPERADMIN_TEST_AUTH_RESOLVER)
 * when no authResolver is given — superAdmin bypasses BOTH the Membership
 * lookup in tenantContext.ts and every requirePermission check, replicating
 * exactly what "no auth exists" meant before this phase, so none of the
 * ~500 pre-Phase-11 tests needed to change. Tests that specifically exercise
 * permission enforcement pass a real authResolver (or use
 * test/helpers/auth.ts's createTestUser/createTestMembership) instead.
 */
export function buildTestServer(tenantId: string, options: BuildTestServerOptions = {}): FastifyInstance {
  return buildServer({
    tenantResolver: async () => tenantId,
    authResolver: options.authResolver ?? SUPERADMIN_TEST_AUTH_RESOLVER,
    logger: false,
  });
}
