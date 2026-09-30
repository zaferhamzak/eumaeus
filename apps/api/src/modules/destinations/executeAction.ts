import type { DestinationExecutor } from "./executors/types.js";
import { archiveExecutor } from "./executors/archiveExecutor.js";
import { webhookExecutor } from "./executors/webhookExecutor.js";
import { forwardExecutor } from "./executors/forwardExecutor.js";
import { flagExecutor } from "./executors/flagExecutor.js";
import { autoReplyExecutor } from "./executors/autoReplyExecutor.js";
import { slackExecutor, teamsExecutor } from "./executors/chatExecutor.js";
import { jiraExecutor, zendeskExecutor } from "./executors/ticketExecutor.js";
import { prisma } from "../../db/client.js";
import { recordAuditEvent, AuditEventType } from "../audit/record.js";
import { escalateToHumanReview } from "../review/escalate.js";
import { loadEnabledChannel } from "./resolveDestination.js";
import { checkIdempotency } from "./idempotency.js";
import { metrics } from "../../metrics/metrics.js";
import { MetricName } from "../../metrics/names.js";
import { emailNotifyExecutor } from "./notify.js";

export interface ExecuteActionInput {
  emailId: string;
  routingDecisionId: string;
  destinationChannelId: string;
  idempotencyKey: string;
}

const DEFAULT_EXECUTORS: Record<string, DestinationExecutor> = {
  archive: archiveExecutor,
  webhook: webhookExecutor,
  forward: forwardExecutor,
  flag: flagExecutor,
  auto_reply: autoReplyExecutor,
  slack: slackExecutor,
  teams: teamsExecutor,
  jira: jiraExecutor,
  zendesk: zendeskExecutor,
  email_notify: emailNotifyExecutor,
};

function getExecutor(channelType: string, executors: Record<string, DestinationExecutor>): DestinationExecutor {
  const executor = executors[channelType];
  if (!executor) {
    // Unreachable in Phase 5A (manageDestinations.ts rejects any other type at
    // save time) — defensive, not a case this phase's data can actually produce.
    throw new Error(`No executor registered for channel type "${channelType}"`);
  }
  return executor;
}

/**
 * The execute-action queue's job handler body (one call per already-resolved
 * DestinationChannel — see dispatchRoutingDecision.ts for how a matched
 * RoutingDecision fans out into one or more calls to this function).
 *
 * Flow (phase5-destinations-architecture.md Revision 2, this phase's brief §9):
 *   idempotency check -> (skip | escalate-stale | proceed)
 *   -> re-verify the channel is still enabled (config can change between
 *      dispatch-time resolution and this job actually running)
 *   -> create a "pending" ActionExecution row, DB-race-protected (partial unique
 *      index on (idempotency_key) WHERE status='pending' — see the migration)
 *   -> run the executor (never throws — always resolves to an ExecutionOutcome)
 *   -> finalize the row, audit, and either return, re-throw (retryable failure,
 *      let BullMQ retry the job), or escalate to Human Review (permanent
 *      failure / ambiguous outcome).
 *
 * `executors` is optional and exists only for tests — production code (the
 * execute-action worker) never passes it, so the real, registered executors are
 * used. Mirrors the exact clientFactory-injection pattern already established
 * throughout this codebase (analyzeEmail, syncMailbox, buildProcessEmailJobHandler).
 */
export async function executeAction(input: ExecuteActionInput, executors: Record<string, DestinationExecutor> = DEFAULT_EXECUTORS): Promise<void> {
  const email = await prisma.email.findUniqueOrThrow({ where: { id: input.emailId } });

  const decision = await checkIdempotency(input.idempotencyKey, await resolveChannelTypeForKey(input));

  if (decision.action === "skip_succeeded" || decision.action === "skip_in_progress") {
    return;
  }

  if (decision.action === "skip_ambiguous") {
    await escalateToHumanReview(email.tenantId, email.id, {
      errorMessage: `Execution ${decision.existing.id} has an ambiguous outcome and is not retried automatically`,
      attemptsMade: 0,
      reason: "execution_ambiguous",
    });
    return;
  }

  if (decision.action === "skip_permanently_failed") {
    // Same reasoning as skip_ambiguous: never auto-retried. escalateToHumanReview
    // is idempotent (no-ops if an open item already exists — it does, from the
    // original failure), so this is safe even if called repeatedly.
    await escalateToHumanReview(email.tenantId, email.id, {
      errorMessage: `Execution ${decision.existing.id} failed permanently (${decision.existing.errorClass ?? "unknown"}) and is not retried automatically`,
      attemptsMade: 0,
      reason: "execution_failed",
    });
    return;
  }

  if (decision.action === "stale_pending") {
    // Atomic conditional UPDATE, race-safe if two callers both discover the same
    // stale row: only one can flip status from "pending" to "ambiguous" — the
    // other's updateMany affects zero rows and is a no-op, exactly the same
    // pattern as modules/mail-providers/imap/sync.ts's tryAcquireSyncLock.
    const finalized = await prisma.actionExecution.updateMany({
      where: { id: decision.existing.id, status: "pending" },
      data: { status: "ambiguous", completedAt: new Date(), errorMessage: "Pending execution exceeded its staleness threshold — presumed crashed mid-attempt" },
    });
    if (finalized.count === 1) {
      // Only the actual winner of this atomic race performs the side effects.
      // escalateToHumanReview's own existing-open-item check is a
      // check-then-insert inside its own transaction — safe against a LATER,
      // sequential call (the item it would find already committed), but not
      // safe against a second call arriving genuinely concurrently, which is
      // exactly what a second racing loser calling it unconditionally would
      // be. Gating both the audit AND the escalation behind `count === 1`
      // ensures a losing caller here never calls escalateToHumanReview at all,
      // so that race is never entered in the first place (Phase 5A audit fix:
      // duplicate-escalation-under-true-concurrency, found while adding the
      // stale-pending race test).
      await recordAuditEvent(prisma, {
        tenantId: email.tenantId,
        emailId: email.id,
        eventType: AuditEventType.ACTION_EXECUTION_AMBIGUOUS,
        actor: "system",
        payload: { destinationChannelId: input.destinationChannelId, attemptNumber: decision.existing.attemptNumber, reason: "stale_pending" },
      });
      metrics.increment(MetricName.ACTION_STALE_PENDING_FINALIZED, { channelType: decision.existing.channelType });
      await escalateToHumanReview(email.tenantId, email.id, {
        errorMessage: "A prior execution attempt did not complete and could not be confirmed — treated as ambiguous",
        attemptsMade: 0,
        reason: "execution_ambiguous",
      });
    }
    return;
  }

  // decision.action === "proceed"
  const channel = await loadEnabledChannel(email.tenantId, input.destinationChannelId);
  if (!channel) {
    await recordAuditEvent(prisma, {
      tenantId: email.tenantId,
      emailId: email.id,
      eventType: AuditEventType.DESTINATION_RESOLUTION_FAILED,
      actor: "system",
      payload: { destinationChannelId: input.destinationChannelId, reason: "channel disabled or no longer exists" },
    });
    await escalateToHumanReview(email.tenantId, email.id, {
      errorMessage: `DestinationChannel ${input.destinationChannelId} is no longer enabled`,
      attemptsMade: 0,
      reason: "execution_failed",
    });
    return;
  }

  const attemptNumber = (await prisma.actionExecution.count({ where: { idempotencyKey: input.idempotencyKey } })) + 1;

  let execution;
  try {
    execution = await prisma.actionExecution.create({
      data: {
        tenantId: email.tenantId,
        emailId: email.id,
        routingDecisionId: input.routingDecisionId,
        destinationChannelId: channel.id,
        channelType: channel.type,
        channelVersion: channel.version,
        idempotencyKey: input.idempotencyKey,
        attemptNumber,
        status: "pending",
      },
    });
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      // Lost the race to the partial unique index: another caller already holds
      // the pending row for this idempotencyKey. Not an error — the other
      // attempt is handling it.
      return;
    }
    throw error;
  }

  await recordAuditEvent(prisma, {
    tenantId: email.tenantId,
    emailId: email.id,
    eventType: AuditEventType.ACTION_EXECUTION_STARTED,
    actor: "system",
    payload: { destinationChannelId: channel.id, channelType: channel.type, attemptNumber },
  });
  metrics.increment(MetricName.ACTION_ATTEMPT, { channelType: channel.type });

  // Loaded here, not earlier — these reads only matter to the executor itself
  // (webhook's payload; archive ignores both), so they are skipped entirely by
  // every skip_*/stale_pending short-circuit above that never reaches this point.
  const routingDecision = await prisma.routingDecision.findUniqueOrThrow({ where: { id: input.routingDecisionId } });
  const analysisResult = routingDecision.analysisResultId
    ? await prisma.analysisResult.findUnique({ where: { id: routingDecision.analysisResultId } })
    : null;

  const executor = getExecutor(channel.type, executors);
  const outcome = await executor.execute({
    tenantId: email.tenantId,
    email: {
      id: email.id,
      mailboxConnectionId: email.mailboxConnectionId,
      externalId: email.externalId,
      uidValidity: email.uidValidity,
      subject: email.subject ?? "",
      fromAddress: email.fromAddress,
      toAddresses: email.toAddresses,
    },
    routing: { destinationRef: routingDecision.destinationRef ?? "" },
    analysis: analysisResult?.answers ? { signals: analysisResult.answers as Record<string, unknown> } : undefined,
    channel: { id: channel.id, type: channel.type, config: channel.config, destinationId: channel.destinationId },
    idempotencyKey: input.idempotencyKey,
  });

  // Every outcome-resolution write below is a CONDITIONAL update — guarded by
  // `status: "pending"`, exactly like the stale_pending branch above and
  // finalizeExhaustedAction (queue/workers/executeAction.worker.ts). This row
  // may have been finalized by a racing actor (the stale-pending self-check
  // above running from a second caller, or the worker.on("failed") backstop)
  // WHILE this executor call was still genuinely in flight. `count === 0`
  // means exactly that happened: the row is already terminal, and this
  // outcome — however it resolved — arrived too late to matter. It must be
  // discarded outright: no status overwrite, no duplicate terminal audit, no
  // duplicate Human Review escalation. (Phase 5A audit finding: terminal-state
  // unconditional overwrite race.)

  if (outcome.status === "succeeded") {
    const finalized = await prisma.actionExecution.updateMany({
      where: { id: execution.id, status: "pending" },
      data: { status: "succeeded", completedAt: new Date(), responseMetadata: outcome.responseMetadata as never as object },
    });
    if (finalized.count === 0) {
      return;
    }
    await recordAuditEvent(prisma, {
      tenantId: email.tenantId,
      emailId: email.id,
      eventType: AuditEventType.ACTION_EXECUTION_SUCCEEDED,
      actor: "system",
      payload: { destinationChannelId: channel.id, attemptNumber },
    });
    metrics.increment(MetricName.ACTION_OUTCOME, { channelType: channel.type, outcome: "succeeded" });
    return;
  }

  if (outcome.status === "ambiguous") {
    const finalized = await prisma.actionExecution.updateMany({
      where: { id: execution.id, status: "pending" },
      data: { status: "ambiguous", completedAt: new Date(), errorMessage: outcome.errorMessage, responseMetadata: outcome.responseMetadata as never as object },
    });
    if (finalized.count === 0) {
      return;
    }
    await recordAuditEvent(prisma, {
      tenantId: email.tenantId,
      emailId: email.id,
      eventType: AuditEventType.ACTION_EXECUTION_AMBIGUOUS,
      actor: "system",
      payload: { destinationChannelId: channel.id, attemptNumber, errorMessage: outcome.errorMessage },
    });
    metrics.increment(MetricName.ACTION_OUTCOME, { channelType: channel.type, outcome: "ambiguous" });
    await escalateToHumanReview(email.tenantId, email.id, {
      errorMessage: outcome.errorMessage,
      attemptsMade: attemptNumber,
      reason: "execution_ambiguous",
    });
    return;
  }

  // outcome.status === "failed"
  const finalized = await prisma.actionExecution.updateMany({
    where: { id: execution.id, status: "pending" },
    data: {
      status: "failed",
      completedAt: new Date(),
      retryable: outcome.retryable,
      errorClass: outcome.errorClass,
      errorMessage: outcome.errorMessage,
    },
  });
  if (finalized.count === 0) {
    return;
  }
  await recordAuditEvent(prisma, {
    tenantId: email.tenantId,
    emailId: email.id,
    eventType: AuditEventType.ACTION_EXECUTION_FAILED,
    actor: "system",
    payload: { destinationChannelId: channel.id, attemptNumber, errorClass: outcome.errorClass, retryable: outcome.retryable },
  });
  metrics.increment(MetricName.ACTION_OUTCOME, { channelType: channel.type, outcome: outcome.retryable ? "retryable_failure" : "permanent_failure" });

  if (outcome.retryable) {
    // Let BullMQ's own attempts/backoff on the execute-action queue retry the
    // whole job — a fresh pending row (attemptNumber+1) next time. No
    // independent retry counter here.
    throw new Error(outcome.errorMessage);
  }

  await escalateToHumanReview(email.tenantId, email.id, {
    errorMessage: outcome.errorMessage,
    attemptsMade: attemptNumber,
    reason: "execution_failed",
  });
}

/**
 * checkIdempotency needs the channel's type to derive the correct staleness
 * threshold (each channel type's own timeout — see idempotency.ts), but the type
 * isn't in ExecuteActionInput (the queue job payload is deliberately minimal —
 * this phase's brief §11). If a prior ActionExecution exists for this key, its
 * own recorded channelType is authoritative and cheaper than a fresh channel
 * lookup; only on the very first attempt (no prior row) do we fall back to
 * loading the channel directly.
 */
async function resolveChannelTypeForKey(input: ExecuteActionInput): Promise<string> {
  const priorAttempt = await prisma.actionExecution.findFirst({
    where: { idempotencyKey: input.idempotencyKey },
    orderBy: { createdAt: "desc" },
    select: { channelType: true },
  });
  if (priorAttempt) return priorAttempt.channelType;

  const channel = await prisma.destinationChannel.findUnique({ where: { id: input.destinationChannelId } });
  // If the channel itself can't be found, "archive" is a safe placeholder purely
  // for staleness-threshold purposes — the subsequent loadEnabledChannel() check
  // below is what actually rejects a missing/disabled channel with a proper
  // destination_resolution_failed outcome; this fallback never reaches that path
  // silently (it only affects which timeout number checkIdempotency uses when
  // there is, by construction, no pending row yet to be stale in the first place).
  return channel?.type ?? "archive";
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}
