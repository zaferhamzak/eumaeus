import { Queue } from "bullmq";
import { getRedisConnection } from "./connection.js";

/**
 * Phase 2's durable reconciliation mechanism. This queue's jobs do nothing on their
 * own — the worker (queue/workers/mailboxSync.worker.ts) does nothing but call the
 * existing syncMailbox(). No IMAP logic lives here or in the scheduler below; this
 * file is purely "how often does a sync-mailbox job get created."
 */
export const MAILBOX_SYNC_QUEUE = "mailbox-sync";

export interface MailboxSyncJobData {
  mailboxConnectionId: string;
  /** 1.1 (C): an IDLE-triggered sync that was already re-queued once. */
  retried?: boolean;
}

let queue: Queue<MailboxSyncJobData> | undefined;

export function getMailboxSyncQueue(): Queue<MailboxSyncJobData> {
  if (!queue) {
    queue = new Queue<MailboxSyncJobData>(MAILBOX_SYNC_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        // syncMailbox() already has its own mailbox-level lock and leaves state
        // exactly where a failure occurred, so a failed sync job is always safe to
        // retry — BullMQ's own backoff handles the "IMAP temporarily unavailable"
        // case without any extra code here.
        attempts: 5,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { age: 60 * 60 * 24 * 7 }, // 7 days
        // Dead-letter for inspection (implementation-plan.md §O), bounded per
        // Phase 7 §19 — see queue/queues.ts's identical reasoning.
        removeOnFail: { age: 60 * 60 * 24 * 30 }, // 30 days
      },
    });
  }
  return queue;
}

/**
 * Registers (or updates) the durable, Redis-backed recurring schedule for one
 * mailbox — this IS the reconciliation scheduler. BullMQ persists job schedulers in
 * Redis, so once registered the schedule keeps producing jobs across worker
 * restarts without anything re-registering it; this function is still called again
 * on every worker startup (see worker.ts) purely as a self-healing measure for the
 * case where Redis itself lost its data (e.g. a fresh Redis with no persistence) —
 * upsertJobScheduler is idempotent by jobSchedulerId, so calling it repeatedly with
 * the same id and interval never creates a second, duplicate schedule.
 */
export async function scheduleMailboxSync(mailboxConnectionId: string, intervalMs: number): Promise<void> {
  await getMailboxSyncQueue().upsertJobScheduler(
    schedulerId(mailboxConnectionId),
    { every: intervalMs },
    { name: "sync", data: { mailboxConnectionId } },
  );
}

export async function unscheduleMailboxSync(mailboxConnectionId: string): Promise<void> {
  await getMailboxSyncQueue().removeJobScheduler(schedulerId(mailboxConnectionId));
}

/**
 * Phase 6: the mechanism behind `POST /api/v1/mailboxes/:id/reconcile` — a
 * single, one-off sync-mailbox job, enqueued through this SAME queue the
 * recurring reconciliation schedule already uses. mailboxSync.worker.ts's
 * handler doesn't distinguish job names (see that file); this is not a second
 * mechanism, just a manually-triggered instance of the existing one. No jobId
 * is set deliberately: unlike the recurring schedule (one scheduler per
 * mailbox, upserted) or execute-action (one job per idempotencyKey), a manual
 * "reconcile now" is allowed to be requested more than once — syncMailbox()'s
 * own mailbox-level lock (modules/mail-providers/imap/sync.ts) is what makes
 * two overlapping sync attempts for the same mailbox safe, not queue-level
 * dedup.
 */
export async function enqueueMailboxReconciliation(mailboxConnectionId: string): Promise<{ jobId: string }> {
  const job = await getMailboxSyncQueue().add("manual-reconcile", { mailboxConnectionId });
  return { jobId: job.id ?? schedulerId(mailboxConnectionId) };
}

/**
 * 1.1 (C): an IDLE connection saw new mail. Runs the ordinary sync at once.
 * Bursts are folded: one job per mailbox per 2-second window (the job id
 * repeats within the window and BullMQ ignores the duplicate). Not retried —
 * the polling sync is the safety net — and removed once done.
 */
export async function enqueueIdleSync(mailboxConnectionId: string, delayMs = 0, retried = false): Promise<void> {
  const bucket = Math.floor((Date.now() + delayMs) / 2000);
  await getMailboxSyncQueue().add(IDLE_SYNC_JOB, { mailboxConnectionId, ...(retried ? { retried } : {}) }, { jobId: `idle-${mailboxConnectionId}-${bucket}${retried ? "-r" : ""}`, delay: delayMs, attempts: 1, removeOnComplete: true, removeOnFail: { age: 60 * 60 * 24 } });
}

export const IDLE_SYNC_JOB = "idle-sync";

/**
 * 1.1 (C): polling slows to `fallbackMs` while the mailbox's IDLE connection
 * is live and returns to `normalMs` when it isn't. Only ever adjusts an
 * existing schedule — a mailbox without one (disabled, waiting for a new
 * sign-in) is left unscheduled.
 */
export async function applyPollInterval(mailboxConnectionId: string, live: boolean, normalMs: number, fallbackMs: number): Promise<void> {
  const desired = live ? Math.max(normalMs, fallbackMs) : normalMs;
  const current = await getMailboxSyncQueue().getJobScheduler(schedulerId(mailboxConnectionId));
  // For an id with a ":" that has no scheduler, BullMQ returns a made-up legacy
  // entry (no `every`, `next: null`) instead of undefined — that is "none" too.
  if (typeof current?.every !== "number" || current.every === desired) return;
  await scheduleMailboxSync(mailboxConnectionId, desired);
}

/** Phase 7 shutdown step: closes the Queue PRODUCER object (distinct from the Worker — see queue/workers/mailboxSync.worker.ts) if one was ever created in this process. A no-op otherwise. */
export async function closeMailboxSyncQueue(): Promise<void> {
  if (!queue) return;
  await queue.close();
  queue = undefined;
}

export function schedulerId(mailboxConnectionId: string): string {
  return `mailbox-sync:${mailboxConnectionId}`;
}
