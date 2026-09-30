import { Queue, Worker } from "bullmq";
import { getRedisConnection } from "./connection.js";
import { runReviewDigests } from "../modules/review/reviewDigest.js";
import { notifyPendingAssignments } from "../modules/review/assignmentNotify.js";
import { logger } from "../logger.js";

/**
 * One global, Redis-persisted "tick" every few minutes. Per-organization
 * cadence (reviewDigestIntervalMinutes) is decided inside runReviewDigests(),
 * not by one scheduler per org — so changing an org's interval in the UI
 * takes effect on the next tick with nothing to reschedule. A job scheduler
 * (not setInterval) means only ONE worker instance runs each tick even if
 * several worker processes are up.
 */
export const REVIEW_DIGEST_QUEUE = "review-digest";
const TICK_MS = 5 * 60_000;
const SCHEDULER_ID = "review-digest:tick";

let queue: Queue | undefined;

function getReviewDigestQueue(): Queue {
  if (!queue) {
    queue = new Queue(REVIEW_DIGEST_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: { attempts: 1, removeOnComplete: { count: 100 }, removeOnFail: { age: 60 * 60 * 24 * 7 } },
    });
  }
  return queue;
}

export async function scheduleReviewDigest(): Promise<void> {
  await getReviewDigestQueue().upsertJobScheduler(SCHEDULER_ID, { every: TICK_MS }, { name: "tick", data: {} });
}

export async function closeReviewDigestQueue(): Promise<void> {
  if (!queue) return;
  await queue.close();
  queue = undefined;
}

export function startReviewDigestWorker(): Worker {
  const worker = new Worker(
    REVIEW_DIGEST_QUEUE,
    async () => {
      const results = await runReviewDigests();
      const sent = results.filter((r) => r.sent > 0);
      if (sent.length > 0) logger.info({ event: "review_digests_sent", results: sent }, `sent review digests for ${sent.length} organization(s)`);
      // Assignment emails whose threshold was reached without a fresh assignment (threshold lowered, earlier send failed).
      const assigned = await notifyPendingAssignments();
      if (assigned > 0) logger.info({ event: "assignment_emails_sent", count: assigned }, `sent ${assigned} assignment email(s)`);
    },
    { connection: getRedisConnection() },
  );
  worker.on("failed", (_job, error) => logger.error({ event: "review_digest_tick_failed", err: error }, "review digest tick failed"));
  return worker;
}
