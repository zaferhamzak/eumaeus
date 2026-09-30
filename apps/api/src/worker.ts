import { loadEnv } from "./config/env.js";
import { releaseActiveSyncLocks } from "./modules/mail-providers/imap/sync.js";
import { isImapConnectionLeftover, startWorkerHeartbeat } from "./runtime/workerHeartbeat.js";
import { getRedisConnection } from "./queue/connection.js";
import { prisma } from "./db/client.js";
import { startProcessEmailWorker } from "./queue/workers/processEmail.worker.js";
import { startMailboxSyncWorker } from "./queue/workers/mailboxSync.worker.js";
import { startExecuteActionWorker } from "./queue/workers/executeAction.worker.js";
import { scheduleMailboxSync, closeMailboxSyncQueue } from "./queue/mailboxSyncQueue.js";
import { closeProcessEmailQueue } from "./queue/queues.js";
import { closeExecuteActionQueue } from "./queue/executeActionQueue.js";
import { startReviewDigestWorker, scheduleReviewDigest, closeReviewDigestQueue } from "./queue/reviewDigestQueue.js";
import { startMaintenanceWorker, scheduleMaintenance, closeMaintenanceQueue } from "./queue/maintenanceQueue.js";
import { startForwardDigestWorker, scheduleForwardDigest, closeForwardDigestQueue } from "./queue/forwardDigestQueue.js";
import { startOpsAlertsWorker, scheduleOpsAlerts, closeOpsAlertsQueue } from "./queue/opsAlertsQueue.js";
import { closeRedisConnection } from "./queue/connection.js";
import { validateSecretKey } from "./modules/secrets/secretCrypto.js";
import { getSystemSettings } from "./modules/settings/systemSettings.js";
import { logger } from "./logger.js";
import { RuntimeState } from "./runtime/state.js";
import { createShutdownCoordinator } from "./runtime/shutdown.js";
import { startIdleRunner } from "./runtime/idleRunner.js";

/**
 * Worker process entrypoint. Runs three BullMQ consumers:
 *   - process-email  (Phase 3: Jev analysis; Phase 4: rule evaluation; Phase 5A:
 *                      dispatches a matched RoutingDecision into execute-action)
 *   - mailbox-sync   (Phase 2's reconciliation job — its handler just calls the
 *                      existing syncMailbox())
 *   - execute-action (Phase 5A: runs one DestinationChannel execution per job —
 *                      its handler just calls the existing executeAction())
 *
 * and registers the durable reconciliation schedule for every currently-active
 * mailbox connection. Registration is idempotent (see scheduleMailboxSync's docs)
 * so it is safe, and necessary, to run on every startup — that is what makes the
 * schedule self-healing after a Redis restart that wiped its persisted schedulers.
 *
 * Startup order (Phase 7 §6): load+validate config -> start workers -> register
 * the shutdown coordinator and signal handlers (so a failure in the NEXT step
 * can still clean up what already started) -> register schedules (a real DB
 * query — §28's "partial startup failure" scenario) -> mark ready.
 */
const env = loadEnv();
// Phase 5B: fail fast if the webhook-secret encryption key is missing/malformed —
// before any worker starts accepting jobs, not the first time a webhook executes.
validateSecretKey();

const runtimeState = new RuntimeState();

const processEmailWorker = startProcessEmailWorker();
const mailboxSyncWorker = startMailboxSyncWorker();
const executeActionWorker = startExecuteActionWorker();
const reviewDigestWorker = startReviewDigestWorker();
const maintenanceWorker = startMaintenanceWorker();
const forwardDigestWorker = startForwardDigestWorker();
const opsAlertsWorker = startOpsAlertsWorker();

/**
 * Shutdown order (Phase 7 §2, adapted to this process — no HTTP server, no
 * scheduler object to stop separately from the workers themselves):
 *   1. Close each BullMQ Worker — this alone is what "stop accepting new
 *      queue work" means here: Worker.close() stops picking up new jobs and
 *      waits (bounded by the grace period below) for any currently-active job
 *      to finish, preserving the existing ActionExecution/AnalysisResult
 *      stale-pending recovery semantics rather than killing an in-flight job
 *      mid-write. The persisted mailbox-sync SCHEDULE in Redis is
 *      deliberately NOT torn down here — it must survive this process exiting
 *      so restart (or another worker instance) picks it back up; "stop
 *      scheduling new work" (§4) is what closing mailboxSyncWorker already
 *      achieves (no new jobs from the schedule get PROCESSED, even though the
 *      schedule keeps existing).
 *   2. Close each Queue PRODUCER object (distinct from the Workers above —
 *      created the moment anything calls scheduleMailboxSync/
 *      enqueueProcessEmail/enqueueExecuteAction).
 *   3. Close the shared Redis connection (after every Worker/Queue, per
 *      connection.ts's own ordering requirement).
 *   4. Disconnect Prisma.
 *
 * Built (and signal handlers wired) BEFORE registerSchedulesForActiveMailboxes()
 * runs below — deliberately: §28 requires that if a LATER startup step fails
 * (that DB query, specifically), the workers already started here get shut
 * down cleanly instead of being left running while the process crashes out
 * from an unhandled rejection.
 */
let stopHeartbeat: () => Promise<void> = async () => {};
let stopIdle: () => Promise<void> = async () => {};
const shutdown = createShutdownCoordinator(
  [
    // IDLE connections first: they only trigger syncs, and must not queue new ones during shutdown.
    { name: "stop_idle_connections", run: () => stopIdle() },
    { name: "close_process_email_worker", run: () => processEmailWorker.close() },
    { name: "close_mailbox_sync_worker", run: () => mailboxSyncWorker.close() },
    // Syncs cut off by the grace period hand their mailbox back immediately.
    { name: "release_sync_locks", run: () => releaseActiveSyncLocks().then(() => undefined) },
    { name: "close_execute_action_worker", run: () => executeActionWorker.close() },
    { name: "close_review_digest_worker", run: () => reviewDigestWorker.close() },
    { name: "close_maintenance_worker", run: () => maintenanceWorker.close() },
    { name: "close_forward_digest_worker", run: () => forwardDigestWorker.close() },
    { name: "close_ops_alerts_worker", run: () => opsAlertsWorker.close() },
    { name: "close_mailbox_sync_queue_producer", run: () => closeMailboxSyncQueue() },
    { name: "close_process_email_queue_producer", run: () => closeProcessEmailQueue() },
    { name: "close_execute_action_queue_producer", run: () => closeExecuteActionQueue() },
    { name: "close_review_digest_queue_producer", run: () => closeReviewDigestQueue() },
    { name: "close_maintenance_queue_producer", run: () => closeMaintenanceQueue() },
    { name: "close_forward_digest_queue_producer", run: () => closeForwardDigestQueue() },
    { name: "close_ops_alerts_queue_producer", run: () => closeOpsAlertsQueue() },
    { name: "stop_worker_heartbeat", run: () => stopHeartbeat() },
    { name: "close_redis", run: () => closeRedisConnection() },
    { name: "disconnect_prisma", run: () => prisma.$disconnect() },
  ],
  { logger, state: runtimeState, gracePeriodMs: env.SHUTDOWN_GRACE_PERIOD_MS },
);

process.on("SIGINT", () => void shutdown.runAndExit());
process.on("SIGTERM", () => void shutdown.runAndExit());

// §29: a fatal process error must not leave the process silently running in a
// possibly-unsafe state — log full diagnostic context, then drive the SAME
// bounded shutdown sequence used for a signal, then exit non-zero.
process.on("uncaughtException", (error) => {
  logger.fatal({ event: "uncaught_exception", err: error }, "uncaught exception — shutting down");
  void shutdown.runAndExit(1);
});
process.on("unhandledRejection", (reason) => {
  if (isImapConnectionLeftover(reason)) {
    // See workerHeartbeat.ts: a dropped IMAP connection's leftover rejection, already handled by its sync.
    logger.warn({ event: "imap_connection_leftover", err: reason }, "ignored a leftover rejection from a dropped IMAP connection");
    return;
  }
  logger.fatal({ event: "unhandled_rejection", err: reason }, "unhandled promise rejection — shutting down");
  void shutdown.runAndExit(1);
});

try {
  await registerSchedulesForActiveMailboxes();
  await scheduleReviewDigest();
  await scheduleMaintenance();
  await scheduleForwardDigest();
  await scheduleOpsAlerts();
} catch (error) {
  // §28: a failure THIS late in startup must not leave the three workers
  // already constructed above still connected and (in principle) able to pick
  // up jobs — shut down everything that was already started, then exit
  // non-zero, rather than letting this propagate as an unhandled rejection
  // that kills the process without closing anything.
  logger.fatal({ event: "startup_failed", err: error }, "worker startup failed — shutting down already-started components");
  await shutdown.runAndExit(1);
  throw error; // unreachable in practice (runAndExit calls process.exit), kept so TS sees this branch never falls through
}

runtimeState.markReady();
stopHeartbeat = startWorkerHeartbeat(getRedisConnection(), (error) => logger.warn({ event: "worker_heartbeat_failed", err: error }, "could not write the worker heartbeat"));
if (env.MAIL_IDLE_ENABLED && env.MAIL_IDLE_MAX_CONNECTIONS > 0) {
  // 1.1 (C): new mail within seconds — see modules/mail-providers/imap/idle.ts.
  stopIdle = startIdleRunner(getRedisConnection(), env).stop;
}
logger.info({ event: "worker_started" }, "process-email, mailbox-sync, and execute-action workers started, waiting for jobs...");

async function registerSchedulesForActiveMailboxes(): Promise<void> {
  const mailboxes = await prisma.mailboxConnection.findMany({ where: { status: "active" } });

  if (mailboxes.length === 0) {
    logger.info({ event: "no_active_mailboxes" }, "no active mailbox connections found — run `pnpm sync` once to bootstrap one from .env");
    return;
  }

  const settings = await getSystemSettings();
  for (const mailbox of mailboxes) {
    await scheduleMailboxSync(mailbox.id, settings.mailboxSyncIntervalSeconds * 1000);
    logger.info(
      { event: "reconciliation_scheduled", mailboxConnectionId: mailbox.id, intervalSeconds: settings.mailboxSyncIntervalSeconds },
      `reconciliation scheduled for ${mailbox.emailAddress}`,
    );
  }
}
