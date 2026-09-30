import { Queue, Worker } from "bullmq";
import { getRedisConnection } from "./connection.js";
import { runForwardDigests } from "../modules/destinations/forwardDigest.js";
import { runNotifyFlush } from "../modules/destinations/notify.js";
import { logger } from "../logger.js";

/**
 * Phase 13.4: one global tick every 5 minutes; each channel's own interval is
 * checked inside runForwardDigests(), same shape as reviewDigestQueue.ts.
 */
export const FORWARD_DIGEST_QUEUE = "forward-digest";
const TICK_MS = 5 * 60_000;
const SCHEDULER_ID = "forward-digest:tick";

let queue: Queue | undefined;

function getForwardDigestQueue(): Queue {
  if (!queue) {
    queue = new Queue(FORWARD_DIGEST_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: { attempts: 1, removeOnComplete: { count: 100 }, removeOnFail: { age: 60 * 60 * 24 * 7 } },
    });
  }
  return queue;
}

export async function scheduleForwardDigest(): Promise<void> {
  await getForwardDigestQueue().upsertJobScheduler(SCHEDULER_ID, { every: TICK_MS }, { name: "tick", data: {} });
}

export async function closeForwardDigestQueue(): Promise<void> {
  if (!queue) return;
  await queue.close();
  queue = undefined;
}

export function startForwardDigestWorker(): Worker {
  const worker = new Worker(
    FORWARD_DIGEST_QUEUE,
    async () => {
      const results = (await runForwardDigests()).filter((r) => r.outcome !== "not_due");
      if (results.length > 0) logger.info({ event: "forward_digests_run", results }, `forward digests processed for ${results.length} channel(s)`);
      // 1.2 (O): throttled and digest rule notifications that are due.
      const notices = await runNotifyFlush();
      if (notices.length > 0) logger.info({ event: "rule_notifications_flushed", results: notices }, `queued rule notifications sent for ${notices.length} channel(s)`);
    },
    { connection: getRedisConnection() },
  );
  worker.on("failed", (_job, error) => logger.error({ event: "forward_digest_tick_failed", err: error }, "forward digest tick failed"));
  return worker;
}
