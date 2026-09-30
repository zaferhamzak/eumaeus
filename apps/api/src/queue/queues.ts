import { Queue } from "bullmq";
import { getRedisConnection } from "./connection.js";

/**
 * "process-email" stands in for the future `analyze` job from implementation-plan.md
 * §T (the real Jev call). Its handler is currently a placeholder — see
 * queue/workers/processEmail.worker.ts — but the queue/retry/idempotency scaffolding
 * around it is the real thing later phases build on, not a throwaway.
 */
export const PROCESS_EMAIL_QUEUE = "process-email";

export interface ProcessEmailJobData {
  emailId: string;
}

let queue: Queue<ProcessEmailJobData> | undefined;

export function getProcessEmailQueue(): Queue<ProcessEmailJobData> {
  if (!queue) {
    queue = new Queue<ProcessEmailJobData>(PROCESS_EMAIL_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        // Keep failed jobs around for inspection instead of deleting them
        // immediately — implementation-plan.md §O's dead-letter behavior —
        // but bounded (Phase 7 §19: "do not retain unlimited BullMQ job
        // history forever"). 30 days is far more generous than any realistic
        // manual-inspection/retry window; the DURABLE business record survives
        // regardless (AnalysisResult/AuditEvent/HumanReviewItem in Postgres —
        // BullMQ is operational infrastructure, not the source of truth, per
        // §19's own framing).
        removeOnComplete: { age: 60 * 60 * 24 * 7 }, // 7 days
        removeOnFail: { age: 60 * 60 * 24 * 30 }, // 30 days
      },
    });
  }
  return queue;
}

/**
 * Enqueue processing for an email, idempotently.
 *
 * jobId = emailId means BullMQ itself de-duplicates: calling this twice for the same
 * email (e.g. because persistNormalizedEmail ran again on a retried sync and the row
 * already existed) does not create a second queued job. This is what makes it safe
 * to call unconditionally rather than only when a row was newly inserted — see
 * modules/ingestion/persist.ts.
 */
export async function enqueueProcessEmail(emailId: string): Promise<void> {
  await getProcessEmailQueue().add("process", { emailId }, { jobId: emailId });
}

/** Phase 7 shutdown step: closes the Queue PRODUCER object (distinct from the Worker — see queue/workers/processEmail.worker.ts) if one was ever created in this process. A no-op otherwise, so a process that never enqueued anything doesn't open a connection just to close it during shutdown. */
export async function closeProcessEmailQueue(): Promise<void> {
  if (!queue) return;
  await queue.close();
  queue = undefined;
}
