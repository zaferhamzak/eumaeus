import { Worker, type Job } from "bullmq";
import { prisma } from "../../db/client.js";
import { escalateToHumanReview } from "../../modules/review/escalate.js";
import { analyzeEmail, type JevClientFactory } from "../../modules/jev/analyzeEmail.js";
import { JevError } from "../../modules/jev/errors.js";
import { evaluateRulesForEmail } from "../../modules/rules/evaluateRulesForEmail.js";
import { dispatchRoutingDecision } from "../../modules/destinations/dispatchRoutingDecision.js";
import { getRedisConnection } from "../connection.js";
import { PROCESS_EMAIL_QUEUE, type ProcessEmailJobData } from "../queues.js";

/**
 * The "process-email" job's real body, as of Phase 3: analyze the email with Jev.
 * All the actual Jev logic (idempotency, request building, HTTP call, response
 * validation, persistence, audit) lives in modules/jev/analyzeEmail.ts — this
 * handler's only job is to run it and decide what a failure means operationally,
 * exactly mirroring how mailboxSync.worker.ts is a thin wrapper around
 * syncMailbox().
 *
 * Retryable vs. permanent (this phase's §9/§11 — do not retry a deterministic
 * rejection): analyzeEmail() throws a classified JevError (see errors.ts).
 *   - retryable (rate limit, server error, timeout, connection) -> re-thrown, so
 *     BullMQ's existing attempts/backoff (queues.ts, unchanged from Phase 1)
 *     applies. If ALL attempts are exhausted, the existing worker.on("failed")
 *     listener below (unchanged from Phase 1) calls finalizeFailedProcessing.
 *   - permanent (auth, validation, malformed response, unexpected status) ->
 *     escalated to Human Review IMMEDIATELY, without throwing — retrying a
 *     deterministic rejection three times before giving up would just waste time;
 *     the job is left to complete "successfully" from BullMQ's point of view
 *     (the escalation itself is the correct outcome, not a bug to retry away).
 *   - a non-JevError (e.g. the email row itself is missing, or a database error)
 *     is re-thrown as before — Phase 1's original "let BullMQ retry, unknown
 *     failures aren't ours to classify" behavior is preserved.
 *
 * Phase 4 extended this handler with one more step: once analyzeEmail()
 * succeeds, evaluateRulesForEmail() runs (modules/rules/ — a routing DECISION
 * only, nothing is sent/executed). Rule evaluation is deterministic, in-process
 * computation over already-persisted data with no external I/O, so it is never a
 * source of retryable failure — see evaluateRulesForEmail.ts's own try/catch for
 * why it never throws out to here.
 *
 * Phase 5A adds exactly one more step after that: if the resulting
 * RoutingDecision matched, dispatchRoutingDecision() (modules/destinations/) is
 * called to fan out into the execute-action queue (or, for the reserved
 * "human_review" destinationRef, straight into escalateToHumanReview — see that
 * module). evaluateRulesForEmail() itself is unchanged and still returns void —
 * this handler re-reads the RoutingDecision it just produced rather than
 * widening that Phase 4 function's signature.
 */
export function buildProcessEmailJobHandler(clientFactory?: JevClientFactory) {
  return async function processEmailJobHandler(data: ProcessEmailJobData): Promise<void> {
    const email = await prisma.email.findUnique({ where: { id: data.emailId } });
    if (!email) {
      throw new Error(`processEmailJobHandler: no Email found for id ${data.emailId}`);
    }

    try {
      await analyzeEmail(data.emailId, clientFactory);
    } catch (error) {
      if (error instanceof JevError && !error.retryable) {
        await escalateToHumanReview(email.tenantId, email.id, { errorMessage: error.message, attemptsMade: 0 });
        return;
      }
      throw error;
    }

    await evaluateRulesForEmail(data.emailId);

    const routingDecision = await prisma.routingDecision.findFirst({ where: { emailId: data.emailId, supersededAt: null } });
    if (routingDecision?.status === "matched") {
      await dispatchRoutingDecision(routingDecision);
    }
  };
}

/** Default export used by the worker process — no injected client, so the real Jev API is used. */
export const processEmailJobHandler = buildProcessEmailJobHandler();

/**
 * Runs when a job has exhausted every retry attempt configured on the queue
 * (implementation-plan.md §O). This is the concrete mechanism behind "if something
 * fails, represent the failure explicitly and make it ... visible for later human
 * handling" — never a job that just disappears into BullMQ's failed set unseen.
 *
 * Exported separately from the QueueEvents wiring below so it can be tested
 * directly (calling it with a fabricated failure) without depending on real BullMQ
 * retry/backoff timing in the test suite.
 */
export async function finalizeFailedProcessing(
  emailId: string,
  errorMessage: string,
  attemptsMade: number,
): Promise<void> {
  const email = await prisma.email.findUnique({ where: { id: emailId } });
  if (!email) return; // nothing to escalate if the email itself no longer exists
  await escalateToHumanReview(email.tenantId, email.id, { errorMessage, attemptsMade });
}

/** clientFactory is optional and exists only for tests — production code never passes it, so the real JevClient (via env config) is used. */
export function startProcessEmailWorker(clientFactory?: JevClientFactory): Worker<ProcessEmailJobData> {
  const connection = getRedisConnection();
  const handler = buildProcessEmailJobHandler(clientFactory);

  const worker = new Worker<ProcessEmailJobData>(
    PROCESS_EMAIL_QUEUE,
    async (job: Job<ProcessEmailJobData>) => {
      await handler(job.data);
    },
    { connection },
  );

  // The Worker's own 'failed' event carries the real Job, which is what lets us
  // check attemptsMade against the configured max — QueueEvents' equivalent event
  // only carries a jobId/reason pair, not enough to make this decision correctly.
  worker.on("failed", async (job, error) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      await finalizeFailedProcessing(job.data.emailId, error.message, job.attemptsMade);
    }
  });

  return worker;
}
