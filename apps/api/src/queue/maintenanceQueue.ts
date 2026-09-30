import { Queue, Worker } from "bullmq";
import { getRedisConnection } from "./connection.js";
import { purgeExpiredEmailSources } from "../modules/ingestion/emailSourceRetention.js";
import { refreshAllSuggestions } from "../modules/review/suggestions.js";
import { applyRetention } from "../modules/privacy/retention.js";
import { backfillSenderAuth } from "../modules/ingestion/backfillSenderAuth.js";
import { cleanupSyncJobs } from "../modules/ops/queueHealth.js";
import { purgeOldOutboundEmails } from "../modules/email/outboundLog.js";
import { logger } from "../logger.js";

/**
 * Hourly housekeeping, same single-scheduler shape as reviewDigestQueue.ts
 * (one Redis-persisted scheduler, so only one worker instance runs each
 * tick). Purges expired raw email sources (Phase 13), recomputes the
 * allow/block suggestions drawn from Human Review (Phase 16), and applies
 * each organization's retention settings (Phase 20).
 */
export const MAINTENANCE_QUEUE = "maintenance";
const TICK_MS = 60 * 60_000;
const SCHEDULER_ID = "maintenance:tick";

let queue: Queue | undefined;

function getMaintenanceQueue(): Queue {
  if (!queue) {
    queue = new Queue(MAINTENANCE_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: { attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { age: 60 * 60 * 24 * 7 } },
    });
  }
  return queue;
}

export async function scheduleMaintenance(): Promise<void> {
  await getMaintenanceQueue().upsertJobScheduler(SCHEDULER_ID, { every: TICK_MS }, { name: "tick", data: {} });
}

export async function closeMaintenanceQueue(): Promise<void> {
  if (!queue) return;
  await queue.close();
  queue = undefined;
}

export function startMaintenanceWorker(): Worker {
  const worker = new Worker(
    MAINTENANCE_QUEUE,
    async () => {
      // Before the purge: sender verdicts for older mail come from the stored sources about to expire.
      const backfill = await backfillSenderAuth();
      if (backfill.filled > 0) logger.info({ event: "sender_auth_backfilled", ...backfill }, `sender verification filled in for ${backfill.filled} older email(s)`);
      const purged = await purgeExpiredEmailSources();
      if (purged > 0) logger.info({ event: "email_sources_purged", purged }, `purged ${purged} expired raw email source(s)`);
      // Phase 26: failed sync jobs don't pile up (old ones, and those of deleted/disabled mailboxes).
      const cleanup = await cleanupSyncJobs();
      if (cleanup.removedOld + cleanup.removedOrphaned + cleanup.removedSchedules > 0) logger.info({ event: "sync_jobs_cleaned", ...cleanup }, "cleaned up failed mailbox-sync jobs");
      const retention = await applyRetention();
      if (retention.bodiesPurged > 0 || retention.emailsDeleted > 0) logger.info({ event: "retention_applied", ...retention }, `retention: ${retention.bodiesPurged} bodies removed, ${retention.emailsDeleted} emails deleted`);
      // 1.2 (F): the delivery log keeps 90 days.
      const outbound = await purgeOldOutboundEmails();
      if (outbound > 0) logger.info({ event: "outbound_log_purged", removed: outbound }, `removed ${outbound} outgoing-email log row(s) older than 90 days`);
      const openSuggestions = await refreshAllSuggestions();
      if (openSuggestions > 0) logger.info({ event: "routing_suggestions_refreshed", open: openSuggestions }, `${openSuggestions} open routing suggestion(s)`);
    },
    { connection: getRedisConnection() },
  );
  worker.on("failed", (_job, error) => logger.error({ event: "maintenance_tick_failed", err: error }, "maintenance tick failed"));
  return worker;
}
