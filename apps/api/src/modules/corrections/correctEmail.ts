import type { RoutingDecision } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { recordAuditEvent, AuditEventType } from "../audit/record.js";
import { EmailState } from "../../types/email-state.js";
import { dispatchRoutingDecision } from "../destinations/dispatchRoutingDecision.js";
import { undoArchiveExecution, UndoRefusedError } from "../destinations/executors/archiveUndo.js";
import type { ArchiveClientFactory } from "../destinations/executors/archiveExecutor.js";
import { assessRuleChange, sinkDestinations, type RuleImpact } from "../rules/ruleImpact.js";
import type { ConditionNode } from "../rules/conditions.js";
import { subjectWords } from "../review/ruleSuggestions.js";
import { PUBLIC_MAIL_DOMAINS } from "../review/suggestions.js";

/**
 * Phase 24: "this email belongs somewhere else". One action instead of undo +
 * reprocess + list/rule edits by hand:
 *
 *   1. the email's latest move (if any, and not undone) is undone first — if
 *      that fails, nothing else happens and the decision stays as it was;
 *   2. the current decision is superseded by a new one to the chosen
 *      destination (status "matched", no rule — the person decided), and the
 *      destination's actions run as for any decision; "inbox" means leave it
 *      where it now is (decision "left_alone", no actions);
 *   3. the correction is recorded as a PERSON'S DECISION: a resolved Human
 *      Review item (reason "human_correction", spam when the destination is
 *      junk-like, otherwise approved), so allow/block and rule suggestions
 *      learn from it; open review items of the email are resolved the same way.
 *
 * correctionRuleDraft() then proposes a rule so the same mistake doesn't
 * happen again, checked with the rule impact analysis before anything is saved.
 */
export const INBOX = "inbox";
export const LEFT_ALONE = "left_alone";

export class CorrectionError extends Error {
  constructor(
    public readonly code: "not_found" | "unknown_destination" | "already_there" | "undo_failed" | "in_progress",
    message: string,
  ) {
    super(message);
  }
}

export interface CorrectionResult {
  previous: RoutingDecision | null;
  decision: RoutingDecision;
  undone: boolean;
}

function currentDestination(d: RoutingDecision | null): string | null {
  if (!d) return null;
  if (d.status === "sender_allowed") return LEFT_ALONE;
  return d.status === "matched" ? d.destinationRef : "human_review";
}

export async function correctEmail(
  tenantId: string,
  emailId: string,
  target: string,
  actor: string,
  options: { archiveClientFactory?: ArchiveClientFactory } = {},
): Promise<CorrectionResult> {
  const email = await prisma.email.findFirst({ where: { id: emailId, tenantId } });
  if (!email) throw new CorrectionError("not_found", `Email ${emailId} not found`);
  if (target !== INBOX && !(await prisma.destination.findFirst({ where: { tenantId, name: target } }))) {
    throw new CorrectionError("unknown_destination", `There is no destination called "${target}".`);
  }
  if (await prisma.actionExecution.count({ where: { emailId, status: "pending" } })) {
    throw new CorrectionError("in_progress", "An action for this email is still running. Try again when it finishes.");
  }
  const previous = await prisma.routingDecision.findFirst({ where: { emailId, supersededAt: null } });
  const wanted = target === INBOX ? LEFT_ALONE : target;
  if (currentDestination(previous) === wanted) throw new CorrectionError("already_there", "The email is already routed there.");

  // 1. Bring the message back from where the last decision moved it.
  const moves = await prisma.actionExecution.findMany({ where: { emailId, channelType: "archive", status: "succeeded" }, orderBy: { createdAt: "desc" } });
  const undoneIds = new Set(
    (await prisma.actionExecution.findMany({ where: { emailId, channelType: "archive_undo", status: "succeeded" }, select: { idempotencyKey: true } })).map((u) => u.idempotencyKey.slice("undo:".length)),
  );
  const standing = moves.find((m) => !undoneIds.has(m.id) && (m.responseMetadata as { moved?: boolean } | null)?.moved !== false);
  let undone = false;
  if (standing) {
    try {
      const result = await undoArchiveExecution(tenantId, standing.id, actor, options.archiveClientFactory);
      if (result.status !== "succeeded") throw new CorrectionError("undo_failed", `The email couldn't be moved back first (${result.message}); nothing was changed.`);
      undone = true;
    } catch (error) {
      if (error instanceof CorrectionError) throw error;
      if (error instanceof UndoRefusedError) throw new CorrectionError("undo_failed", `The email couldn't be moved back first: ${error.message}`);
      throw error;
    }
  }

  // 2 + 3. New decision, and the person's verdict as review evidence.
  const sinks = await sinkDestinations(tenantId);
  const resolution = target !== INBOX && sinks.has(target) ? "spam" : "approved";
  const now = new Date();
  const decision = await prisma.$transaction(async (tx) => {
    if (previous) await tx.routingDecision.update({ where: { id: previous.id }, data: { supersededAt: now } });
    await tx.humanReviewItem.updateMany({ where: { emailId, status: "open" }, data: { status: "resolved", resolvedAt: now, resolution } });
    await tx.humanReviewItem.create({ data: { tenantId, emailId, reason: "human_correction", status: "resolved", resolution, resolvedAt: now } });
    const created = await tx.routingDecision.create({
      data: { tenantId, emailId, status: "matched", destinationRef: wanted, analysisResultId: previous?.analysisResultId ?? null },
    });
    await tx.email.update({ where: { id: emailId }, data: { state: EmailState.ROUTING, stateUpdatedAt: now } });
    await recordAuditEvent(tx, {
      tenantId,
      emailId,
      eventType: AuditEventType.EMAIL_CORRECTED,
      actor,
      payload: { previousDecisionId: previous?.id ?? null, decisionId: created.id, from: currentDestination(previous), to: wanted, movedBack: undone, resolution },
    });
    return created;
  });
  if (wanted !== LEFT_ALONE) await dispatchRoutingDecision(decision);
  return { previous, decision, undone };
}

export interface CorrectionRuleDraft {
  rule: { name: string; priority: number; destinationRef: string; conditions: ConditionNode };
  /** Other recent emails from the sender (sharing the subject word) that went where this one wrongly went. */
  alsoWrong: number;
  word: string | null;
  impact: RuleImpact;
}

/**
 * A rule that would have sent this email (and its lookalikes) to `target`:
 * sender AND the subject word most shared with the sender's other emails that
 * landed in the same wrong place, placed just before the rule that made the
 * wrong call. Nothing is saved — the person reviews the impact and creates it.
 */
export async function correctionRuleDraft(tenantId: string, emailId: string, target: string, wrongDestination: string | null): Promise<CorrectionRuleDraft> {
  const email = await prisma.email.findFirst({ where: { id: emailId, tenantId } });
  if (!email) throw new CorrectionError("not_found", `Email ${emailId} not found`);
  const address = email.fromAddress.trim().toLowerCase();
  const domain = address.split("@")[1] ?? "";
  const byAddress = !domain || PUBLIC_MAIL_DOMAINS.has(domain);
  const senderLeaf: ConditionNode = byAddress ? { field: "sender.address", op: "==", value: address } : { field: "sender.domain", op: "==", value: domain };

  // Where the wrong decision came from, and its lookalikes.
  const decisions = await prisma.routingDecision.findMany({
    where: { tenantId, emailId, status: "matched" },
    orderBy: { createdAt: "desc" },
    include: { matchedRule: { select: { priority: true } } },
  });
  const wrongRulePriority = decisions.find((d) => d.destinationRef === wrongDestination && d.matchedRule)?.matchedRule?.priority;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const siblings = await prisma.email.findMany({
    where: { tenantId, id: { not: emailId }, receivedAt: { gte: since }, fromAddress: byAddress ? { equals: address, mode: "insensitive" } : { endsWith: `@${domain}`, mode: "insensitive" } },
    select: { id: true, subject: true, routingDecisions: { where: { supersededAt: null }, select: { status: true, destinationRef: true } } },
  });
  const wrongSiblings = siblings.filter((s) => wrongDestination && s.routingDecisions[0]?.status === "matched" && s.routingDecisions[0]?.destinationRef === wrongDestination);

  const words = subjectWords(email.subject);
  let word: string | null = null;
  let best = 0;
  for (const w of words) {
    const n = wrongSiblings.filter((s) => subjectWords(s.subject).includes(w)).length;
    if (n > best || (n === best && n > 0 && word !== null && w.length > word.length)) {
      best = n;
      word = w;
    }
  }
  if (!word && words.length > 0) word = [...words].sort((a, b) => b.length - a.length)[0]!;

  const active = await prisma.rule.findMany({ where: { tenantId, enabled: true, deactivatedAt: null }, select: { priority: true } });
  const used = new Set(active.map((r) => r.priority));
  let priority = wrongRulePriority !== undefined ? wrongRulePriority - 1 : Math.max(0, ...active.map((r) => r.priority)) + 10;
  while (used.has(priority)) priority -= 1;

  const conditions: ConditionNode = word ? { op: "AND", children: [senderLeaf, { field: "subject", op: "contains", value: word }] } : senderLeaf;
  const destinationRef = target === INBOX ? "human_review" : target;
  const rule = { name: `${byAddress ? address : domain}${word ? ` — “${word}”` : ""} → ${destinationRef}`, priority, destinationRef, conditions };
  const impact = await assessRuleChange(tenantId, { type: "create", rule });
  const alsoWrong = word ? wrongSiblings.filter((s) => subjectWords(s.subject).includes(word!)).length : wrongSiblings.length;
  return { rule, alsoWrong, word, impact };
}
