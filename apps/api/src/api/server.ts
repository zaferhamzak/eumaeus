import type { Redis } from "ioredis";
import type { FastifyServerOptions } from "fastify";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import type { Logger } from "../logger.js";
import { genRequestId, registerRequestIdPlugin } from "./plugins/requestId.js";
import { registerErrorHandler } from "./plugins/errorHandler.js";
import { registerAuthContextPlugin, type AuthResolver } from "./plugins/authContext.js";
import { registerTenantContextPlugin, type TenantResolver } from "./plugins/tenantContext.js";
import { registerDrainGuardPlugin } from "./plugins/drainGuard.js";
import { registerRateLimitPlugin, DEFAULT_RATE_LIMIT_CONFIG, type RateLimitConfig } from "./plugins/rateLimit.js";
import { registerMetricsHook } from "./plugins/requestMetrics.js";
import { RuntimeState } from "../runtime/state.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMetricsRoutes } from "./routes/metrics.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerMailboxRoutes } from "./routes/mailboxes.js";
import { registerDestinationRoutes } from "./routes/destinations.js";
import { registerRuleRoutes } from "./routes/rules.js";
import { registerRuleGraphRoutes } from "./routes/ruleGraphs.js";
import { registerOrganizationRoutes } from "./routes/organizations.js";
import { registerMemberRoutes } from "./routes/members.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerEmailRoutes } from "./routes/emails.js";
import { registerRoutingDecisionRoutes } from "./routes/routingDecisions.js";
import { registerActionExecutionRoutes } from "./routes/actionExecutions.js";
import { registerReviewRoutes } from "./routes/reviews.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerOutboundEmailRoutes } from "./routes/outboundEmails.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { registerForwardRecipientRoutes, registerForwardVerificationRoute } from "./routes/forwardRecipients.js";
import { registerSimulationRoutes } from "./routes/simulations.js";
import { registerSenderListRoutes } from "./routes/senderLists.js";
import { registerMailboxOAuthCallbackRoute, registerMailboxOAuthRoutes } from "./routes/mailboxOAuth.js";
import { registerReprocessRoutes } from "./routes/reprocess.js";
import { registerOpsInsightRoutes } from "./routes/opsInsights.js";
import { registerPrivacyRoutes } from "./routes/privacy.js";
import { registerApiKeyRoutes } from "./routes/apiKeys.js";
import { registerQuestionRoutes } from "./routes/questions.js";
import { registerReviewActionRoutes } from "./routes/reviewActions.js";
import { registerCorrectionRoutes } from "./routes/corrections.js";
import { registerDeletionRoutes } from "./routes/deletion.js";

/** The request/JSON body size ceiling (§14) — generously above any real rule/destination config (a condition tree or webhook config is a few KB at most), far below anything that could be used to exhaust memory via a single request. */
export const DEFAULT_BODY_LIMIT_BYTES = 256 * 1024; // 256 KiB

declare module "fastify" {
  interface FastifyInstance {
    /** The single per-process runtime state instance (starting/ready/draining/stopped) — see runtime/state.ts. The entrypoint (src/server.ts) calls `.markReady()` once startup finishes and drives shutdown through runtime/shutdown.ts, which calls `.markDraining()`/`.markStopped()`. Readiness (routes/health.ts) and the drain guard (plugins/drainGuard.ts) both read it. */
    runtimeState: RuntimeState;
  }
}

export interface BuildServerOptions {
  /** Which proxies may set X-Forwarded-For (see TRUST_PROXY in config/env.ts). Unset = none. */
  trustProxy?: boolean | number | string;
  /** Test-only seam: inject a fixed tenant resolver instead of "the one bootstrap tenant." Production code never passes this — see plugins/tenantContext.ts for why this is the auth insertion point. */
  tenantResolver?: TenantResolver;
  /** Test-only seam, same shape as tenantResolver — inject a fixed authenticated principal instead of resolving one from a real session cookie. Production code never passes this. See plugins/authContext.ts. */
  authResolver?: AuthResolver;
  /** Defaults to true outside tests; pass false to silence Fastify's own request/response logging (used by the test suite). Ignored if `loggerInstance` is set. */
  logger?: boolean;
  /** Production code (src/server.ts) passes the shared structured logger (src/logger.ts) so worker and API logs share one format/destination. Tests never set this — they use `logger: false`. */
  loggerInstance?: Logger;
  /** Override for tests that need a tiny window/max to exercise 429s deterministically without waiting on real time. */
  rateLimit?: RateLimitConfig;
  /** Share rate limits across replicas through this Redis (production); unset = in-process (tests). */
  rateLimitRedis?: Redis;
  bodyLimit?: number;
  /**
   * Defaults to true: the returned app's runtimeState is immediately marked
   * `ready` — matching every existing test's assumption (from Phase 6 on)
   * that a freshly-built app is usable right away. Production (src/server.ts)
   * passes `false` and marks ready itself only once `app.listen()` succeeds
   * (§6's explicit startup order — dependencies verified, THEN accept
   * traffic). Phase 7's own lifecycle tests also pass `false` to exercise the
   * starting/draining/stopped transitions directly.
   */
  autoReady?: boolean;
}

/**
 * Builds (but does not start listening on) the Control Plane API app — a
 * factory, not a side-effecting module load, specifically so API tests can
 * build a fresh, isolated instance per test file via `app.inject()` without a
 * real listening socket (see test/api/helpers/buildTestServer.ts).
 *
 * Route layering (Phase 6 brief §2): every route module below only translates
 * HTTP <-> the api/services/* layer, which in turn calls existing domain
 * modules (modules/rules/manageRules.ts, modules/destinations/manageSecrets.ts,
 * etc.) wherever one already exists, or a small focused function alongside them
 * when one doesn't. No route handler touches `prisma` directly.
 *
 * /api/v1/health, /api/v1/ready, and /metrics are registered OUTSIDE the
 * tenant-context scope below — a health/readiness/metrics check must work
 * even before any Tenant row exists, and (§24) must keep responding during a
 * drain, unlike every substantive route (which is registered inside the scoped
 * child plugin below, where request.tenantId, the drain guard, and rate
 * limiting are all applied).
 */
export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  // Cast: passing `loggerInstance` narrows Fastify's inferred logger generic
  // to the specific pino type, which then fails to structurally match the
  // plain `FastifyInstance` (default `FastifyBaseLogger`) type this function
  // returns and every route-registration function below accepts. Harmless at
  // runtime — a pino instance satisfies FastifyBaseLogger's actual shape.
  const app = Fastify({
    genReqId: genRequestId,
    ...(options.loggerInstance ? { loggerInstance: options.loggerInstance } : { logger: options.logger ?? true }),
    bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT_BYTES,
    ...((options.trustProxy !== undefined ? { trustProxy: options.trustProxy } : {}) as Pick<FastifyServerOptions, "trustProxy">),
  }) as unknown as FastifyInstance;

  const runtimeState = new RuntimeState();
  app.decorate("runtimeState", runtimeState);
  if (options.autoReady ?? true) runtimeState.markReady();

  registerErrorHandler(app);
  registerRequestIdPlugin(app);
  // 1.0: defensive headers on every API response. The API only returns JSON
  // (and CSV downloads) — nothing here is meant to be framed, sniffed or
  // embedded. HSTS is set by the TLS-terminating proxy (Caddy), not here.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    return payload;
  });
  app.register(fastifyCookie);
  registerAuthContextPlugin(app, options.authResolver);
  registerMetricsHook(app);
  registerHealthRoutes(app, runtimeState);
  registerMetricsRoutes(app);
  registerAuthRoutes(app);
  registerForwardVerificationRoute(app);
  registerReviewActionRoutes(app);
  registerMailboxOAuthCallbackRoute(app);

  app.register(async (scoped) => {
    registerTenantContextPlugin(scoped, options.tenantResolver);
    registerDrainGuardPlugin(scoped, runtimeState);
    registerRateLimitPlugin(scoped, options.rateLimit ?? DEFAULT_RATE_LIMIT_CONFIG, options.rateLimitRedis);
    registerMailboxRoutes(scoped);
    registerDestinationRoutes(scoped);
    registerRuleRoutes(scoped);
    registerRuleGraphRoutes(scoped);
    registerOrganizationRoutes(scoped);
    registerMemberRoutes(scoped);
    registerSettingsRoutes(scoped);
    registerEmailRoutes(scoped);
    registerRoutingDecisionRoutes(scoped);
    registerActionExecutionRoutes(scoped);
    registerReviewRoutes(scoped);
    registerAuditRoutes(scoped);
    registerOutboundEmailRoutes(scoped);
    registerStatsRoutes(scoped);
    registerForwardRecipientRoutes(scoped);
    registerSimulationRoutes(scoped);
    registerSenderListRoutes(scoped);
    registerMailboxOAuthRoutes(scoped);
    registerReprocessRoutes(scoped);
    registerOpsInsightRoutes(scoped);
    registerPrivacyRoutes(scoped);
    registerApiKeyRoutes(scoped);
    registerQuestionRoutes(scoped);
    registerCorrectionRoutes(scoped);
    registerDeletionRoutes(scoped);
  });

  return app;
}
