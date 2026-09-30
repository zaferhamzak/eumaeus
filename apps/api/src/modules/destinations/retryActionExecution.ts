import type { ActionExecution } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { getExecuteActionQueue } from "../../queue/executeActionQueue.js";

export type RetryOutcome =
  | { status: "not_found" }
  | { status: "invalid_state"; reason: string }
  | { status: "retried"; execution: ActionExecution };

/**
 * Phase 6's manual-retry operation (brief §22). Deliberately does NOT enqueue a
 * NEW job or call an executor directly — the execute-action queue already has a
 * job whose id IS this execution's idempotencyKey
 * (queue/executeActionQueue.ts's `jobId: data.idempotencyKey`), and
 * `removeOnFail: false` means it is still sitting in BullMQ's failed set once
 * every attempt has been exhausted. Re-adding a job with that same id would be
 * a silent no-op (BullMQ deduplicates by jobId regardless of state) — the
 * correct, idiomatic BullMQ operation for "try this failed job again" is
 * `Job.retry()`, which moves the EXISTING job back to waiting and re-invokes
 * the SAME handler (executeAction()) with the SAME data. That in turn goes
 * through checkIdempotency() exactly as any other invocation would — this
 * function grants no special bypass of the idempotency/terminal-state
 * machinery audited in Phase 5A/5B.
 *
 * Only ever allowed for `status === "failed" && retryable === true` — never
 * succeeded (already done), never ambiguous (must not be auto-retried, per
 * idempotency.ts's own policy), never permanently failed (retryable === false).
 */
export async function retryActionExecution(tenantId: string, actionExecutionId: string): Promise<RetryOutcome> {
  const execution = await prisma.actionExecution.findFirst({ where: { id: actionExecutionId, tenantId } });
  if (!execution) return { status: "not_found" };

  if (execution.status !== "failed" || execution.retryable !== true) {
    return {
      status: "invalid_state",
      reason: `ActionExecution ${actionExecutionId} is not in a retryable state (status="${execution.status}", retryable=${String(execution.retryable)})`,
    };
  }

  const job = await getExecuteActionQueue().getJob(execution.idempotencyKey);
  if (!job) {
    return { status: "invalid_state", reason: "No queued job was found for this execution's idempotency key — it may already have been retried, or its job record was cleaned up" };
  }

  const state = await job.getState();
  if (state !== "failed") {
    return { status: "invalid_state", reason: `The underlying job is not in a failed state (state="${state}") — it may already be retrying or in progress` };
  }

  await job.retry();
  return { status: "retried", execution };
}
