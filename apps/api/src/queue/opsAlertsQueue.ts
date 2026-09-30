import { Queue, Worker } from "bullmq";
import { getRedisConnection } from "./connection.js";
import { evaluateAlerts } from "../modules/alerts/evaluateAlerts.js";
import { logger } from "../logger.js";

/** Phase 18: operational alerts, evaluated every 5 minutes (same single-scheduler shape as reviewDigestQueue.ts). */
export const OPS_ALERTS_QUEUE = "ops-alerts";
const TICK_MS = 5 * 60_000;
const SCHEDULER_ID = "ops-alerts:tick";

let queue: Queue | undefined;

function getOpsAlertsQueue(): Queue {
  if (!queue) {
    queue = new Queue(OPS_ALERTS_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: { attempts: 1, removeOnComplete: { count: 100 }, removeOnFail: { age: 60 * 60 * 24 * 7 } },
    });
  }
  return queue;
}

export async function scheduleOpsAlerts(): Promise<void> {
  await getOpsAlertsQueue().upsertJobScheduler(SCHEDULER_ID, { every: TICK_MS }, { name: "tick", data: {} });
}

export async function closeOpsAlertsQueue(): Promise<void> {
  if (!queue) return;
  await queue.close();
  queue = undefined;
}

export function startOpsAlertsWorker(): Worker {
  const worker = new Worker(
    OPS_ALERTS_QUEUE,
    async () => {
      const { opened, resolved } = await evaluateAlerts();
      if (opened + resolved > 0) logger.info({ event: "ops_alerts_evaluated", opened, resolved }, `alerts: ${opened} opened, ${resolved} resolved`);
    },
    { connection: getRedisConnection() },
  );
  worker.on("failed", (_job, error) => logger.error({ event: "ops_alerts_tick_failed", err: error }, "ops alerts tick failed"));
  return worker;
}
