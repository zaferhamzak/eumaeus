import type { RoutingDecision } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { recordAuditEvent, AuditEventType } from "../audit/record.js";
import { evaluateRulesForEmail } from "../rules/evaluateRulesForEmail.js";
import { dispatchRoutingDecision } from "../destinations/dispatchRoutingDecision.js";
import { analyzeEmail, type JevClientFactory } from "../jev/analyzeEmail.js";

/**
 * Re-running routing for an email with today's rules, graphs and lists
 * (Phase 18) — e.g. after fixing a rule that sent mail to the wrong place.
 *
 * The current decision isn't changed or deleted: it's marked superseded, and
 * a new one is made by the live engine itself (evaluateRulesForEmail), then
 * dispatched exactly like fresh mail — so its actions really run. Jev is not
 * called again; the stored analysis is reused.
 *
 * Refused, with a reason a person can act on, when:
 *   - an action for this email is still running;
 *   - the email was moved to another folder by an earlier decision and that
 *     move hasn't been undone. A new move would look for the message in the
 *     inbox and not find it, so the move has to be undone first.
 *
 * Open Human Review items for the email are closed: the new decision
 * replaces the question they were asking (a new one is opened if the new
 * decision needs review too).
 */
export class ReprocessRefusedError extends Error {
  constructor(
    public readonly code: "not_found" | "in_progress" | "moved_elsewhere" | "content_removed" | "analysis_failed",
    message: string,
  ) {
    super(message);
  }
}

export interface ReprocessResult {
  emailId: string;
  previousDecisionId: string | null;
  decision: RoutingDecision;
}

export interface ReprocessOptions {
  /** Phase 22: ask Jev again first (billed; picks up the organization's current questions). */
  reanalyze?: boolean;
  /** Tests only. */
  jevClientFactory?: JevClientFactory;
}

export async function reprocessEmail(tenantId: string, emailId: string, actor: string, options: ReprocessOptions = {}): Promise<ReprocessResult> {
  const email = await prisma.email.findFirst({ where: { id: emailId, tenantId } });
  if (!email) throw new ReprocessRefusedError("not_found", `Email ${emailId} not found`);

  if (await prisma.actionExecution.count({ where: { emailId, status: "pending" } })) {
    throw new ReprocessRefusedError("in_progress", "An action for this email is still running. Try again when it finishes.");
  }

  const moves = await prisma.actionExecution.findMany({ where: { emailId, channelType: "archive", status: "succeeded" }, select: { id: true, responseMetadata: true } });
  const undone = new Set(
    (await prisma.actionExecution.findMany({ where: { emailId, channelType: "archive_undo", status: "succeeded" }, select: { idempotencyKey: true } })).map((u) => u.idempotencyKey.replace(/^undo:/, "")),
  );
  const stillMoved = moves.find((m) => (m.responseMetadata as { moved?: boolean } | null)?.moved !== false && !undone.has(m.id));
  if (stillMoved) {
    const folder = (stillMoved.responseMetadata as { targetFolder?: string } | null)?.targetFolder;
    throw new ReprocessRefusedError("moved_elsewhere", `This email was moved to ${folder ? `"${folder}"` : "another folder"} by an earlier decision. Undo that move first, then reprocess.`);
  }

  // Re-analysis happens before anything is superseded: if Jev fails, the
  // email keeps its current decision untouched.
  if (options.reanalyze) {
    if (email.bodyPurgedAt) throw new ReprocessRefusedError("content_removed", "This email's content was removed by the retention policy, so Jev can't be asked again. Reprocess without asking Jev.");
    try {
      await analyzeEmail(emailId, options.jevClientFactory, { force: true });
    } catch (error) {
      throw new ReprocessRefusedError("analysis_failed", `Jev could not analyze the email again: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const now = new Date();
  const previous = await prisma.routingDecision.findFirst({ where: { emailId, supersededAt: null } });
  await prisma.$transaction(async (tx) => {
    if (previous) await tx.routingDecision.update({ where: { id: previous.id }, data: { supersededAt: now } });
    // "superseded", not "resolved": nobody decided anything about these items —
    // the new decision replaced the question they asked. Keeping them apart
    // means "resolved" always means a person's call, so review statistics and
    // the allow/block suggestions (review/suggestions.ts) only ever count human
    // decisions. resolvedAt still records when the item was closed.
    await tx.humanReviewItem.updateMany({ where: { emailId, status: "open" }, data: { status: "superseded", resolvedAt: now } });
  });

  await evaluateRulesForEmail(emailId);
  const decision = await prisma.routingDecision.findFirstOrThrow({ where: { emailId, supersededAt: null } });
  if (decision.status === "matched") await dispatchRoutingDecision(decision);

  await recordAuditEvent(prisma, {
    tenantId,
    emailId,
    eventType: AuditEventType.EMAIL_REPROCESSED,
    actor,
    payload: { previousDecisionId: previous?.id ?? null, decisionId: decision.id, status: decision.status, destinationRef: decision.destinationRef, reanalyzed: Boolean(options.reanalyze) },
  });
  return { emailId, previousDecisionId: previous?.id ?? null, decision };
}
