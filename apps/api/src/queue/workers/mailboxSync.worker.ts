import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "../connection.js";
import { enqueueIdleSync, IDLE_SYNC_JOB, MAILBOX_SYNC_QUEUE, type MailboxSyncJobData } from "../mailboxSyncQueue.js";
import { syncMailbox } from "../../modules/mail-providers/imap/sync.js";

type SyncMailboxClientFactory = Parameters<typeof syncMailbox>[1];

/**
 * Deliberately the thinnest possible wrapper: syncMailbox() is the ONLY ingestion
 * path (this phase's explicit instruction) and already does everything —
 * connecting, locking, persisting, updating the cursor and health fields, and
 * recording its own audit trail on both success and failure. This handler exists
 * only so BullMQ has something to call; there is no IMAP or persistence logic here
 * to duplicate or drift out of sync with the manual `pnpm sync` path.
 *
 * clientFactory is optional and exists only for tests (mirrors syncMailbox's own
 * seam) — production code never passes it, so the real ImapFlowMailClient is used.
 */
export function startMailboxSyncWorker(clientFactory?: SyncMailboxClientFactory): Worker<MailboxSyncJobData> {
  const connection = getRedisConnection();

  const worker = new Worker<MailboxSyncJobData>(
    MAILBOX_SYNC_QUEUE,
    async (job: Job<MailboxSyncJobData>) => {
      const result = await syncMailbox(job.data.mailboxConnectionId, clientFactory);
      // 1.1 (C): new mail reported by IDLE while another sync of the same
      // mailbox was running may have landed after that sync's fetch. Look
      // again shortly (once) instead of leaving it to the fallback poll.
      if (job.name === IDLE_SYNC_JOB && result.skipReason === "concurrent_sync_in_progress" && !job.data.retried) {
        await enqueueIdleSync(job.data.mailboxConnectionId, 3_000, true);
      }
    },
    { connection },
  );

  worker.on("failed", (job, error) => {
    // syncMailbox() already wrote a MAILBOX_SYNC_FAILED audit event and updated the
    // mailbox's health fields before this job handler's promise rejected — nothing
    // more to record here. BullMQ's own attempts/backoff (see mailboxSyncQueue.ts)
    // is what makes the retry happen; this listener only surfaces it to process logs.
    console.error(`[mailbox-sync] job ${job?.id} failed (attempt ${job?.attemptsMade}):`, error.message);
  });

  return worker;
}
