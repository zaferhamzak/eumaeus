import type { RoutingDecision } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { recordAuditEvent, AuditEventType } from "../audit/record.js";
import { escalateToHumanReview } from "../review/escalate.js";
import { resolveDestination } from "./resolveDestination.js";
import { computeIdempotencyKey } from "./idempotency.js";
import { enqueueExecuteAction } from "../../queue/executeActionQueue.js";
import { RESERVED_HUMAN_REVIEW_DESTINATION_REF } from "./types.js";

/**
 * The entry point from the rest of the system into the destinations module —
 * called by processEmail.worker.ts exactly once a RoutingDecision.status ===
 * "matched" (see that file). Not named in the original architecture doc's file
 * list explicitly, but required by the queue job payload's own shape: a job
 * needs an already-resolved destinationChannelId (idempotencyKey is derived
 * from it), so resolution has to happen HERE, before enqueueing — not inside the
 * execute-action worker itself.
 *
 * Resolves the RoutingDecision's destinationRef to one of two things:
 *   1. The reserved "human_review" value -> calls the EXISTING
 *      escalateToHumanReview() directly. No Destination lookup, no
 *      ActionExecution, no queue job — see types.ts's doc comment for why.
 *   2. A real, tenant-scoped Destination -> fans out one execute-action job per
 *      enabled channel (Phase 5A: at most one, since "archive" is the only
 *      supported channel type, but the fan-out itself is not special-cased to
 *      "exactly one" — a destination with multiple channels already works
 *      correctly once 5B/5C add more channel types).
 */
export async function dispatchRoutingDecision(routingDecision: RoutingDecision): Promise<void> {
  if (routingDecision.status !== "matched" || !routingDecision.destinationRef) {
    // Defensive — the only caller (processEmail.worker.ts) already checks this,
    // but dispatchRoutingDecision must never silently act on a non-matched
    // decision if called some other way in the future.
    return;
  }

  const email = await prisma.email.findUniqueOrThrow({ where: { id: routingDecision.emailId } });

  if (routingDecision.destinationRef === RESERVED_HUMAN_REVIEW_DESTINATION_REF) {
    await escalateToHumanReview(email.tenantId, email.id, {
      errorMessage: routingDecision.senderListPattern
        ? `The sender matches the block list entry "${routingDecision.senderListPattern}", and blocked mail goes to Human Review`
        : routingDecision.ruleGraphId
          ? `Rule graph "${routingDecision.ruleGraphId}" (v${routingDecision.ruleGraphVersion}) explicitly routed this email to Human Review`
          : `Rule "${routingDecision.matchedRuleId}" explicitly routed this email to Human Review`,
      attemptsMade: 0,
      reason: "manual_review_requested",
    });
    return;
  }

  const resolved = await resolveDestination(email.tenantId, routingDecision.destinationRef);
  if (!resolved) {
    await recordAuditEvent(prisma, {
      tenantId: email.tenantId,
      emailId: email.id,
      eventType: AuditEventType.DESTINATION_RESOLUTION_FAILED,
      actor: "system",
      payload: { destinationRef: routingDecision.destinationRef },
    });
    await escalateToHumanReview(email.tenantId, email.id, {
      errorMessage: `destinationRef "${routingDecision.destinationRef}" does not resolve to any enabled destination for this tenant`,
      attemptsMade: 0,
      reason: "execution_failed",
    });
    return;
  }

  for (const channel of resolved.channels) {
    const idempotencyKey = computeIdempotencyKey(email.id, routingDecision.id, channel.id);
    await enqueueExecuteAction({
      emailId: email.id,
      routingDecisionId: routingDecision.id,
      destinationChannelId: channel.id,
      idempotencyKey,
    });
  }
}
