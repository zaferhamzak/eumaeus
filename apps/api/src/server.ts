import { loadEnv } from "./config/env.js";
import { DEFAULT_RATE_LIMIT_CONFIG } from "./api/plugins/rateLimit.js";
import { getRedisConnection } from "./queue/connection.js";
import { prisma } from "./db/client.js";
import { validateSecretKey } from "./modules/secrets/secretCrypto.js";
import { ensureBootstrapAdminUser } from "./modules/auth/bootstrapAdmin.js";
import { buildServer } from "./api/server.js";
import { closeRedisConnection } from "./queue/connection.js";
import { closeSessionRedisConnection } from "./modules/auth/sessionStore.js";
import { closeMailboxSyncQueue } from "./queue/mailboxSyncQueue.js";
import { closeExecuteActionQueue } from "./queue/executeActionQueue.js";
import { logger } from "./logger.js";
import { createShutdownCoordinator } from "./runtime/shutdown.js";
import { startWorkerWatchdog } from "./runtime/workerWatchdog.js";

/**
 * Control Plane API process entrypoint (Phase 6; hardened in Phase 7) —
 * separate from worker.ts (queue consumers) and sync-once.ts (the manual
 * CLI): this process only ever reads/serves HTTP, and enqueues work by
 * calling the same queue modules worker.ts's consumers listen on. It never
 * calls an executor or performs long-running IMAP/HTTP work itself (§23).
 *
 * Startup order (§6): load+validate config -> build the Fastify app (routes
 * registered, but runtimeState stays `starting` — see `autoReady: false`) ->
 * register the shutdown coordinator and signal handlers (so a listen()
 * failure below can still clean up whatever WAS already touched — §28) ->
 * start listening -> ONLY THEN mark ready. Readiness (GET /api/v1/ready)
 * reports `runtime: "error"` for the whole window between process start and
 * this last step, exactly as intended: a load balancer must not route real
 * traffic here before the HTTP listener itself is actually bound.
 */
const env = loadEnv();
validateSecretKey();
await ensureBootstrapAdminUser(env);

const app = buildServer({ loggerInstance: logger, autoReady: false, rateLimitRedis: getRedisConnection(), rateLimit: { ...DEFAULT_RATE_LIMIT_CONFIG, global: { windowMs: 60_000, max: env.RATE_LIMIT_PER_MINUTE } }, ...(env.TRUST_PROXY !== undefined ? { trustProxy: env.TRUST_PROXY } : {}) });

/**
 * Shutdown order (§2, adapted — no BullMQ Worker in this process, only
 * Fastify and the Queue producers retry/reconcile use):
 *   1. app.close() — Fastify itself stops accepting new connections and
 *      waits for in-flight requests to finish (its own built-in graceful
 *      close behavior); the drain guard (api/plugins/drainGuard.ts) already
 *      started rejecting brand-new requests the moment runtimeState flipped
 *      to `draining` (done by the shutdown coordinator itself, before any
 *      step runs). Safe to call even if listen() never succeeded.
 *   2. Close the Queue PRODUCER objects this process may have created via the
 *      retry/reconcile endpoints (getExecuteActionQueue()/
 *      getMailboxSyncQueue()) — a no-op if neither endpoint was ever hit.
 *   3. Close the shared Redis connection.
 *   4. Disconnect Prisma.
 */
let stopWorkerWatchdog: () => void = () => {};

const shutdown = createShutdownCoordinator(
  [
    { name: "close_fastify", run: () => app.close() },
    { name: "stop_worker_watchdog", run: async () => stopWorkerWatchdog() },
    { name: "close_mailbox_sync_queue_producer", run: () => closeMailboxSyncQueue() },
    { name: "close_execute_action_queue_producer", run: () => closeExecuteActionQueue() },
    { name: "close_redis", run: () => closeRedisConnection() },
    { name: "close_session_redis", run: () => closeSessionRedisConnection() },
    { name: "disconnect_prisma", run: () => prisma.$disconnect() },
  ],
  { logger, state: app.runtimeState, gracePeriodMs: env.SHUTDOWN_GRACE_PERIOD_MS },
);

process.on("SIGINT", () => void shutdown.runAndExit());
process.on("SIGTERM", () => void shutdown.runAndExit());

process.on("uncaughtException", (error) => {
  logger.fatal({ event: "uncaught_exception", err: error }, "uncaught exception — shutting down");
  void shutdown.runAndExit(1);
});
process.on("unhandledRejection", (reason) => {
  logger.fatal({ event: "unhandled_rejection", err: reason }, "unhandled promise rejection — shutting down");
  void shutdown.runAndExit(1);
});

try {
  await app.listen({ port: env.API_PORT, host: env.API_HOST });
} catch (error) {
  // §28: listen() failing (e.g. port already in use) must not leave the
  // already-built Fastify app / any lazily-opened resource dangling — run the
  // same shutdown sequence, then exit non-zero.
  logger.fatal({ event: "startup_failed", err: error }, "API server failed to start listening — shutting down");
  await shutdown.runAndExit(1);
  throw error; // unreachable in practice (runAndExit calls process.exit), kept so TS sees this branch never falls through
}

app.runtimeState.markReady();

// 1.1: nobody else notices a dead worker — see runtime/workerWatchdog.ts.
if (env.WORKER_WATCHDOG_MINUTES > 0) {
  stopWorkerWatchdog = startWorkerWatchdog(getRedisConnection(), { thresholdMs: env.WORKER_WATCHDOG_MINUTES * 60_000 });
}
