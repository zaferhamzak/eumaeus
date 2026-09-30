import type { Email } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { recordAuditEvent, AuditEventType } from "../audit/record.js";
import { escalateToHumanReview } from "../review/escalate.js";
import { EmailState } from "../../types/email-state.js";
import { decideRouting, type GraphForDecision } from "./decideRouting.js";
import type { SenderListEntryForDecision } from "./senderLists.js";
import { metrics } from "../../metrics/metrics.js";
import { MetricName } from "../../metrics/names.js";
import { computeDerivedFields } from "./derivedFields.js";

/**
 * Jev's own `human_review_required` signal (a Noul probability) forces
 * escalation before any rule is evaluated, once it reaches the
 * organization's threshold. Per-organization since Phase 12
 * (Tenant.humanReviewSignalThreshold / humanReviewSignalEnabled, default
 * 0.5 / on): a hardcoded 0.5 sent the large majority of a noisy real inbox
 * (newsletters, notifications) to Human Review before rules ever ran. It's
 * still an org-level setting, not a per-rule condition, so no individual
 * rule author can silently bypass it.
 */

/**
 * The Rule Engine's single entry point:
 *
 *   AnalysisResult -> Rule Engine -> RoutingDecision
 *
 * Called by the worker AFTER a successful Jev analysis (see
 * queue/workers/processEmail.worker.ts) — never calls Jev itself, never imports
 * anything from modules/jev/ or a future modules/destinations/ (see
 * test/architecture/rulesModuleBoundary.test.ts). Produces a routing DECISION
 * only; nothing is sent, forwarded, or archived here.
 *
 * Idempotent: a RoutingDecision already existing for this email means it was
 * already evaluated — evaluation is a pure function of (AnalysisResult, active
 * rule set), so re-running it can only ever reproduce the same answer, and this
 * function does not bother re-deriving it. This is what "processing the same
 * analyzed email twice must not create contradictory routing decisions" means in
 * practice: the second call is a no-op, not a re-derivation that happens to agree.
 *
 * Every path below is a deterministic, explicit outcome — see this phase's §9
 * list (no rule matches / rule config invalid / missing signal / missing
 * analysis) — never an unhandled exception and never a default "route it
 * somewhere anyway."
 */
export async function evaluateRulesForEmail(emailId: string): Promise<void> {
  const email = await prisma.email.findUniqueOrThrow({ where: { id: emailId } });

  const existingDecision = await prisma.routingDecision.findFirst({ where: { emailId, supersededAt: null } });
  if (existingDecision) return;

  try {
    await runEvaluation(email);
  } catch (error) {
    // An orchestration-level failure (a bug, a malformed rule that slipped past
    // save-time validation in a way conditions.ts's per-rule try/catch didn't
    // anticipate, a database error mid-loop) — never left half-done or thrown
    // up to trigger a pointless BullMQ retry (this is deterministic computation
    // over already-persisted data; retrying an orchestration bug would just fail
    // identically). Recorded explicitly and escalated, per this phase's "invalid
    // rule configuration ... must have explicit deterministic behavior."
    const message = error instanceof Error ? error.message : String(error);
    await createRoutingDecisionSafely(email.tenantId, emailId, { status: "invalid_config", analysisResultId: null });
    await escalateToHumanReview(email.tenantId, emailId, {
      errorMessage: `Rule Engine evaluation failed: ${message}`,
      attemptsMade: 0,
      reason: "ambiguous",
    });
  }
}

async function runEvaluation(email: Email): Promise<void> {
  const emailId = email.id;
  const tenantId = email.tenantId;

  const analysis = await prisma.analysisResult.findFirst({
    where: { emailId, status: "ok" },
    orderBy: { createdAt: "desc" },
  });

  await recordAuditEvent(prisma, {
    tenantId,
    emailId,
    eventType: AuditEventType.RULE_EVALUATION_STARTED,
    actor: "system",
    payload: { analysisResultId: analysis?.id ?? null },
  });

  // Phase 14: the decision itself is decideRouting() (pure, shared with the
  // simulator); this function only loads its inputs and records the outcome.
  const [tenant, graph, rules, senderList] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { humanReviewSignalEnabled: true, humanReviewSignalThreshold: true, blockDestinationRef: true, businessHours: true } }),
    analysis ? loadAssignedGraph(email) : null,
    analysis ? prisma.rule.findMany({ where: { tenantId, enabled: true, deactivatedAt: null }, orderBy: { priority: "asc" } }) : [],
    loadSenderList(tenantId),
  ]);

  const { businessHours, ...policy } = tenant;
  // Phase 22: arrival-time facts (working hours, reply, sender history) — the simulator computes them the same way.
  const derived = (await computeDerivedFields(tenantId, [email], businessHours)).get(email.id);
  const outcome = decideRouting({ email: { ...email, derived }, answers: analysis ? (analysis.answers as Record<string, unknown>) : null, policy, graph, rules, senderList });
  const analysisResultId = analysis?.id ?? null;

  switch (outcome.kind) {
    case "sender_allowed":
      // VIP: recorded, but nothing is done with the email and nobody has to review it.
      await recordAuditEvent(prisma, {
        tenantId,
        emailId,
        eventType: AuditEventType.SENDER_ALLOWED,
        actor: "system",
        payload: { senderListEntryId: outcome.entry.id, pattern: outcome.entry.pattern },
      });
      await createRoutingDecisionSafely(tenantId, emailId, { status: "sender_allowed", analysisResultId, senderListEntryId: outcome.entry.id, senderListPattern: outcome.entry.pattern });
      metrics.increment(MetricName.RULE_EVALUATION_RESULT, { result: "sender_allowed" });
      return;

    case "sender_blocked":
      await recordAuditEvent(prisma, {
        tenantId,
        emailId,
        eventType: AuditEventType.SENDER_BLOCKED,
        actor: "system",
        payload: { senderListEntryId: outcome.entry.id, pattern: outcome.entry.pattern, destinationRef: outcome.destinationRef },
      });
      await createRoutingDecisionSafely(tenantId, emailId, {
        status: "matched",
        analysisResultId,
        destinationRef: outcome.destinationRef,
        senderListEntryId: outcome.entry.id,
        senderListPattern: outcome.entry.pattern,
      });
      await prisma.email.update({ where: { id: emailId }, data: { state: EmailState.ROUTING, stateUpdatedAt: new Date() } });
      await recordAuditEvent(prisma, {
        tenantId,
        emailId,
        eventType: AuditEventType.ROUTING_DECISION_CREATED,
        actor: "system",
        payload: { status: "matched", destinationRef: outcome.destinationRef, senderListPattern: outcome.entry.pattern },
      });
      metrics.increment(MetricName.RULE_EVALUATION_RESULT, { result: "sender_blocked" });
      return;

    case "missing_analysis":
      await createRoutingDecisionSafely(tenantId, emailId, { status: "missing_analysis", analysisResultId: null });
      await escalateToHumanReview(tenantId, emailId, {
        errorMessage: "No successful AnalysisResult exists for this email",
        attemptsMade: 0,
        reason: "ambiguous",
      });
      return;

    case "human_review_forced":
      await recordAuditEvent(prisma, {
        tenantId,
        emailId,
        eventType: AuditEventType.HUMAN_REVIEW_SIGNAL_FORCED_REVIEW,
        actor: "system",
        payload: { humanReviewSignal: outcome.signal, threshold: outcome.threshold },
      });
      await createRoutingDecisionSafely(tenantId, emailId, { status: "human_review_forced", analysisResultId });
      await escalateToHumanReview(tenantId, emailId, {
        errorMessage: `Jev flagged human_review_required (${outcome.signal} >= ${outcome.threshold})`,
        attemptsMade: 0,
        reason: "ambiguous",
      });
      return;

    case "graph_invalid":
      await recordAuditEvent(prisma, {
        tenantId,
        emailId,
        eventType: AuditEventType.RULE_GRAPH_INVALID,
        actor: "system",
        payload: { ruleGraphId: outcome.graph.id, ruleGraphVersion: outcome.graphVersion, reason: outcome.reason },
      });
      await createRoutingDecisionSafely(tenantId, emailId, {
        status: "invalid_config",
        analysisResultId,
        ruleGraphId: outcome.graph.id,
        ruleGraphVersion: outcome.graphVersion ?? undefined,
        graphPath: outcome.path,
      });
      await escalateToHumanReview(tenantId, emailId, {
        errorMessage: `Rule graph "${outcome.graph.name}" could not be evaluated: ${outcome.reason}`,
        attemptsMade: 0,
        reason: "ambiguous",
      });
      metrics.increment(MetricName.RULE_EVALUATION_RESULT, { result: "invalid_config" });
      return;

    case "graph_routed":
      await recordAuditEvent(prisma, {
        tenantId,
        emailId,
        eventType: AuditEventType.RULE_GRAPH_ROUTED,
        actor: "system",
        payload: {
          ruleGraphId: outcome.graph.id,
          ruleGraphName: outcome.graph.name,
          ruleGraphVersion: outcome.graphVersion,
          destinationRef: outcome.destinationRef,
          path: outcome.path.map((step) => ({ nodeKey: step.nodeKey, matched: step.matched })),
        },
      });
      await createRoutingDecisionSafely(tenantId, emailId, {
        status: "matched",
        analysisResultId,
        destinationRef: outcome.destinationRef,
        ruleGraphId: outcome.graph.id,
        ruleGraphVersion: outcome.graphVersion,
        graphPath: outcome.path,
      });
      await prisma.email.update({ where: { id: emailId }, data: { state: EmailState.ROUTING, stateUpdatedAt: new Date() } });
      await recordAuditEvent(prisma, {
        tenantId,
        emailId,
        eventType: AuditEventType.ROUTING_DECISION_CREATED,
        actor: "system",
        payload: { status: "matched", destinationRef: outcome.destinationRef, ruleGraphId: outcome.graph.id },
      });
      metrics.increment(MetricName.RULE_EVALUATION_RESULT, { result: "matched" });
      return;

    case "rule_matched":
    case "unmatched":
      break;
  }

  for (const { rule, trace } of outcome.evaluations) {
    await prisma.ruleEvaluation.create({
      data: { tenantId, emailId, ruleId: rule.id, ruleVersion: rule.version, matched: trace.matched, reason: trace as unknown as object },
    });
  }

  if (outcome.kind === "rule_matched") {
    const winner = outcome.rule;
    await recordAuditEvent(prisma, {
      tenantId,
      emailId,
      eventType: AuditEventType.RULE_MATCHED,
      actor: "system",
      payload: { ruleId: winner.id, ruleVersion: winner.version, ruleName: winner.name, destinationRef: winner.destinationRef },
    });
    await createRoutingDecisionSafely(tenantId, emailId, {
      status: "matched",
      analysisResultId,
      matchedRuleId: winner.id,
      matchedRuleVersion: winner.version,
      destinationRef: winner.destinationRef,
    });
    await prisma.email.update({
      where: { id: emailId },
      data: { state: EmailState.ROUTING, stateUpdatedAt: new Date() },
    });
    await recordAuditEvent(prisma, {
      tenantId,
      emailId,
      eventType: AuditEventType.ROUTING_DECISION_CREATED,
      actor: "system",
      payload: { status: "matched", destinationRef: winner.destinationRef },
    });
    metrics.increment(MetricName.RULE_EVALUATION_RESULT, { result: "matched" });
  } else {
    await recordAuditEvent(prisma, {
      tenantId,
      emailId,
      eventType: AuditEventType.RULE_UNMATCHED,
      actor: "system",
      payload: { rulesEvaluated: rules.length },
    });
    await createRoutingDecisionSafely(tenantId, emailId, { status: "unmatched", analysisResultId });
    await escalateToHumanReview(tenantId, emailId, {
      errorMessage: `No active rule matched (${rules.length} rule(s) evaluated)`,
      attemptsMade: 0,
      reason: "unmatched",
    });
    metrics.increment(MetricName.RULE_EVALUATION_RESULT, { result: "unmatched" });
  }
}

/**
 * Phase 12: an ENABLED graph assigned to the email's mailbox replaces the
 * flat rule list. No graph, a graph from another tenant, or a disabled one ->
 * null (flat rules decide; a disabled graph means "not in use", not "block
 * mail"). An enabled graph without an active version is returned with
 * version null, which decideRouting reports as invalid rather than silently
 * falling back to rules the admin deliberately replaced.
 */
export async function loadAssignedGraph(email: Pick<Email, "tenantId" | "mailboxConnectionId">): Promise<GraphForDecision | null> {
  const mailbox = await prisma.mailboxConnection.findUnique({ where: { id: email.mailboxConnectionId }, select: { ruleGraphId: true } });
  if (!mailbox?.ruleGraphId) return null;
  const graph = await prisma.ruleGraph.findFirst({ where: { id: mailbox.ruleGraphId, tenantId: email.tenantId } });
  if (!graph || !graph.enabled) return null;
  return loadGraphForDecision(graph);
}

export async function loadSenderList(tenantId: string): Promise<SenderListEntryForDecision[]> {
  const rows = await prisma.senderListEntry.findMany({ where: { tenantId }, select: { id: true, kind: true, pattern: true } });
  return rows.map((r) => ({ id: r.id, kind: r.kind as SenderListEntryForDecision["kind"], pattern: r.pattern }));
}

export async function loadGraphForDecision(graph: { id: string; name: string }): Promise<GraphForDecision> {
  const version = await prisma.ruleGraphVersion.findFirst({ where: { ruleGraphId: graph.id, deactivatedAt: null }, orderBy: { version: "desc" } });
  return {
    id: graph.id,
    name: graph.name,
    version: version ? { version: version.version, rootNodeKey: version.rootNodeKey, nodes: await prisma.ruleNode.findMany({ where: { graphVersionId: version.id } }) } : null,
  };
}

interface RoutingDecisionInput {
  status: "matched" | "unmatched" | "human_review_forced" | "invalid_config" | "missing_analysis" | "sender_allowed";
  analysisResultId: string | null;
  matchedRuleId?: string;
  matchedRuleVersion?: number;
  destinationRef?: string;
  ruleGraphId?: string;
  ruleGraphVersion?: number;
  graphPath?: unknown;
  senderListEntryId?: string;
  senderListPattern?: string;
}

/** Idempotent by construction (unique emailId) — a race between two evaluations of the same email is safe: the second insert simply fails the unique constraint and is ignored. */
async function createRoutingDecisionSafely(tenantId: string, emailId: string, input: RoutingDecisionInput): Promise<void> {
  await prisma.routingDecision
    .create({
      data: {
        tenantId,
        emailId,
        status: input.status,
        analysisResultId: input.analysisResultId,
        matchedRuleId: input.matchedRuleId,
        matchedRuleVersion: input.matchedRuleVersion,
        destinationRef: input.destinationRef,
        ruleGraphId: input.ruleGraphId,
        ruleGraphVersion: input.ruleGraphVersion,
        graphPath: input.graphPath === undefined ? undefined : (input.graphPath as object),
        senderListEntryId: input.senderListEntryId,
        senderListPattern: input.senderListPattern,
      },
    })
    .catch((error: { code?: string }) => {
      if (error?.code !== "P2002") throw error; // unique constraint on emailId = another concurrent evaluation already won
    });
}
