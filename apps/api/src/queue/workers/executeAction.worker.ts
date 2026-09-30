import { Worker, type Job } from "bullmq";
import { prisma } from "../../db/client.js";
import { recordAuditEvent, AuditEventType } from "../../modules/audit/record.js";
import { escalateToHumanReview } from "../../modules/review/escalate.js";
import { executeAction } from "../../modules/destinations/executeAction.js";
import { getRedisConnection } from "../connection.js";
import { EXECUTE_ACTION_QUEUE, type ExecuteActionJobData } from "../executeActionQueue.js";
import { metrics } from "../../metrics/metrics.js";
import { MetricName } from "../../metrics/names.js";

/**
 * Thin wrapper, mirrors queue/workers/mailboxSync.worker.ts exactly: all the real
 * logic (idempotency, executor dispatch, ActionExecution persistence, audit,
 * escalation) lives in modules/destinations/executeAction.ts. This file exists
 * only so BullMQ has something to call and to wire the failure backstop below.
 */
export function startExecuteActionWorker(): Worker<ExecuteActionJobData> {
  const connection = getRedisConnection();

  const worker = new Worker<ExecuteActionJobData>(
    EXECUTE_ACTION_QUEUE,
    async (job: Job<ExecuteActionJobData>) => {
      await executeAction(job.data);
    },
    { connection },
  );

  // The authoritative crash-recovery backstop (this phase's explicit instruction:
  // "DB'de stale pending execution'ı bulan self-check authoritative safety
  // backstop olmalıdır" — NOT this BullMQ event, which is not guaranteed to fire
  // for every crash). This listener is a SECOND, complementary layer: it only
  // ever runs once BullMQ has given up on the job entirely (attempts + any
  // stalled-job redeliveries exhausted). The actual stale-pending detection that
  // survives an ordinary crash-and-redeliver cycle happens on every invocation of
  // executeAction() itself, via checkIdempotency() — see that module's docs.
  worker.on("failed", async (job, error) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      await finalizeExhaustedAction(job.data.idempotencyKey, error.message, job.attemptsMade);
    }
  });

  return worker;
}

/**
 * Runs when BullMQ has exhausted every attempt (including stalled-job
 * redeliveries) for a given execute-action job. Exported separately so it can be
 * tested directly, mirroring finalizeFailedProcessing's exact pattern
 * (queue/workers/processEmail.worker.ts).
 */
export async function finalizeExhaustedAction(idempotencyKey: string, errorMessage: string, attemptsMade: number): Promise<void> {
  const latest = await prisma.actionExecution.findFirst({
    where: { idempotencyKey },
    orderBy: { createdAt: "desc" },
  });
  if (!latest) return;

  const email = await prisma.email.findUnique({ where: { id: latest.emailId } });
  if (!email) return;

  if (latest.status === "pending") {
    // The backstop's own version of the stale-pending finalization — same
    // atomic conditional UPDATE pattern as executeAction.ts's, idempotent if
    // this ever races with a fresh self-check from a redelivered job. Only the
    // actual winner (count === 1) performs the audit AND the escalation — see
    // the identical reasoning in executeAction.ts's stale_pending branch: an
    // unconditional escalateToHumanReview call from a losing racer can race
    // against a concurrent winner's own escalation inside
    // escalateToHumanReview's check-then-insert transaction and create a
    // duplicate HumanReviewItem.
    const finalized = await prisma.actionExecution.updateMany({
      where: { id: latest.id, status: "pending" },
      data: { status: "ambiguous", completedAt: new Date(), errorMessage: "BullMQ exhausted all attempts while this execution was still pending" },
    });
    if (finalized.count === 1) {
      await recordAuditEvent(prisma, {
        tenantId: email.tenantId,
        emailId: email.id,
        eventType: AuditEventType.ACTION_EXECUTION_AMBIGUOUS,
        actor: "system",
        payload: { idempotencyKey, reason: "bullmq_attempts_exhausted" },
      });
      metrics.increment(MetricName.ACTION_STALE_PENDING_FINALIZED, { channelType: latest.channelType });
      await escalateToHumanReview(email.tenantId, email.id, { errorMessage, attemptsMade, reason: "execution_ambiguous" });
    }
    return;
  }

  if (latest.status === "failed") {
    // A genuinely exhausted retryable failure (executeAction.ts already recorded
    // this specific attempt's own failed row and audit event; this is the
    // queue-level "no more attempts left" escalation on top of that).
    await escalateToHumanReview(email.tenantId, email.id, { errorMessage, attemptsMade, reason: "execution_failed" });
  }
  // succeeded/ambiguous are already terminal and already handled by
  // executeAction.ts itself — nothing left to do here.
}
