import { Queue } from "bullmq";
import { getRedisConnection } from "./connection.js";

/**
 * Phase 5A's execution queue — separate from process-email, mirroring the exact
 * two-queue precedent already established (process-email / mailbox-sync):
 * destination execution is external I/O with independent latency/failure modes,
 * unlike Phase 4's in-process rule evaluation, so it gets its own queue rather
 * than growing process-email's job further (phase5-destinations-architecture.md
 * Revision 2 §10).
 */
export const EXECUTE_ACTION_QUEUE = "execute-action";

export interface ExecuteActionJobData {
  emailId: string;
  routingDecisionId: string;
  destinationChannelId: string;
  idempotencyKey: string;
}

let queue: Queue<ExecuteActionJobData> | undefined;

export function getExecuteActionQueue(): Queue<ExecuteActionJobData> {
  if (!queue) {
    queue = new Queue<ExecuteActionJobData>(EXECUTE_ACTION_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        // Closer to mailbox-sync's profile than process-email's: external
        // destinations can be slow to recover, and executeAction.ts's own
        // pending-row-based idempotency (not this queue) is the real safety
        // boundary regardless of how many times BullMQ retries.
        attempts: 5,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { age: 60 * 60 * 24 * 7 }, // 7 days
        // Dead-letter for inspection AND the source a manual retry
        // (modules/destinations/retryActionExecution.ts) resumes via
        // Job.retry() — bounded per Phase 7 §19, 30 days being far longer
        // than any realistic manual-retry response window.
        removeOnFail: { age: 60 * 60 * 24 * 30 }, // 30 days
      },
    });
  }
  return queue;
}

/**
 * jobId = idempotencyKey gives cheap BullMQ-level dedup — but this is NOT the
 * idempotency guarantee (see modules/destinations/idempotency.ts's doc comment):
 * it only prevents the same logical execution from being double-queued at the
 * BullMQ layer. The DB-level check inside executeAction() is what Eumaeus
 * actually relies on; this queue never assumes BullMQ's dedup alone is enough.
 */
export async function enqueueExecuteAction(data: ExecuteActionJobData): Promise<void> {
  await getExecuteActionQueue().add("execute", data, { jobId: data.idempotencyKey });
}

/** Phase 7 shutdown step: closes the Queue PRODUCER object (distinct from the Worker — see queue/workers/executeAction.worker.ts) if one was ever created in this process. A no-op otherwise. */
export async function closeExecuteActionQueue(): Promise<void> {
  if (!queue) return;
  await queue.close();
  queue = undefined;
}
