import { prisma } from "../../db/client.js";
import { decideRouting, type GraphForDecision, type RoutingOutcome, type RuleForDecision } from "./decideRouting.js";
import { validateRule, type RuleInput } from "./validateRule.js";
import { validateRuleGraph } from "../rule-graphs/graphValidation.js";
import type { RuleGraphInput } from "../rule-graphs/types.js";
import { loadGraphForDecision, loadSenderList } from "./evaluateRulesForEmail.js";
import { normalizeSenderPattern, type SenderListEntryForDecision, type SenderListKind } from "./senderLists.js";
import { customFieldTypes } from "./customFields.js";
import { computeDerivedFields } from "./derivedFields.js";

/**
 * "What would happen if this rule / graph were live?" (Phase 14), answered by
 * running decideRouting() — the live engine's own decision function — over
 * already-analyzed past emails with the draft swapped in. Read-only: no
 * RoutingDecision, RuleEvaluation, audit event or action is ever written,
 * and Jev is never called (stored analyses are reused).
 */
export const MAX_SIMULATION_EMAILS = 1000;
export const DEFAULT_SIMULATION_EMAILS = 200;
const MAX_SAMPLES = 20;
export const DRAFT_ID = "draft";

export type SimulationTarget =
  /** A new rule, or (with replaceRuleId) an edit of an existing one. Graphs assigned to mailboxes still win, exactly as live. */
  | { type: "rule"; rule: RuleInput; replaceRuleId?: string }
  /** A graph applied to every email in scope, as if assigned to their mailboxes and enabled. */
  | { type: "graph"; graph: RuleGraphInput }
  /** Phase 18: no draft — what the CURRENT configuration would decide (the reprocess preview). */
  | { type: "current" }
  /** Phase 16: a new allow / block list entry (replaces an existing entry with the same pattern). */
  | { type: "sender_entry"; entry: { kind: SenderListKind; pattern: string } };

export interface SimulationScope {
  /** Phase 18: exactly these emails (still tenant-scoped); other filters still apply. */
  emailIds?: string[];
  mailboxConnectionIds?: string[];
  since?: Date;
  until?: Date;
  limit?: number;
}

export interface SimulatedRoute {
  /** A destination name, or "human_review". */
  destinationRef: string;
  kind: RoutingOutcome["kind"] | "not_routed";
  ruleId?: string;
  ruleName?: string;
  /** Graph targets: the node keys visited. */
  path?: Array<{ nodeKey: string; matched: boolean }>;
}

export interface SimulationSample {
  emailId: string;
  subject: string | null;
  fromAddress: string;
  receivedAt: string;
  /** What actually happened (from the stored RoutingDecision). null = the email was never routed. */
  before: SimulatedRoute | null;
  after: SimulatedRoute;
  changed: boolean;
}

export interface SimulationResult {
  evaluated: number;
  /** More emails matched the scope than the limit allowed; the newest `limit` were used. */
  truncated: boolean;
  /** Emails without a successful analysis — they can only ever go to Human Review. */
  withoutAnalysis: number;
  /** Rule target: emails the draft rule won. Graph target: emails the graph routed. Sender entry: emails the new entry would catch. */
  draftMatched: number;
  /** Rule target: emails decided by a graph assigned to their mailbox, where the draft rule can't apply. */
  decidedByAssignedGraph: number;
  forcedToReview: number;
  byDestination: Array<{ destinationRef: string; count: number }>;
  /** Emails whose destination would differ from what actually happened. */
  changed: number;
  samples: SimulationSample[];
}

export class SimulationValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Invalid simulation: ${errors.join("; ")}`);
  }
}

export async function simulateRouting(tenantId: string, target: SimulationTarget, scope: SimulationScope = {}): Promise<SimulationResult> {
  const limit = Math.min(Math.max(scope.limit ?? DEFAULT_SIMULATION_EMAILS, 1), MAX_SIMULATION_EMAILS);

  const [activeRules, tenant, currentList] = await Promise.all([
    prisma.rule.findMany({ where: { tenantId, enabled: true, deactivatedAt: null } }),
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { humanReviewSignalEnabled: true, humanReviewSignalThreshold: true, blockDestinationRef: true, businessHours: true } }),
    loadSenderList(tenantId),
  ]);
  const { businessHours, ...policy } = tenant;
  let senderList: SenderListEntryForDecision[] = currentList;

  let rules: RuleForDecision[] = activeRules;
  let draftGraph: GraphForDecision | null = null;
  if (target.type === "sender_entry") {
    const pattern = normalizeSenderPattern(target.entry.pattern);
    if (!pattern || (target.entry.kind !== "allow" && target.entry.kind !== "block")) {
      throw new SimulationValidationError(["the entry needs a kind (allow or block) and an email address or a domain like @example.com"]);
    }
    senderList = [...currentList.filter((e) => e.pattern !== pattern), { id: DRAFT_ID, kind: target.entry.kind, pattern }];
  } else if (target.type === "current") {
    // Nothing to swap in: the live rules, graphs and lists as they are.
  } else if (target.type === "rule") {
    const errors = validateRule(target.rule, await customFieldTypes(tenantId));
    if (target.replaceRuleId && !activeRules.some((r) => r.id === target.replaceRuleId)) errors.push(`rule "${target.replaceRuleId}" is not an active rule of this organization`);
    const others = activeRules.filter((r) => r.id !== target.replaceRuleId);
    const clash = others.find((r) => r.priority === target.rule.priority);
    // Saving would fail the same way (priorities are unique), so the simulation says so instead of guessing an order.
    if (clash) errors.push(`priority ${target.rule.priority} is already used by rule "${clash.name}"`);
    if (errors.length > 0) throw new SimulationValidationError(errors);
    rules = [...others, { id: DRAFT_ID, version: 0, name: target.rule.name, priority: target.rule.priority, conditions: target.rule.conditions, destinationRef: target.rule.destinationRef }];
  } else {
    const errors = validateRuleGraph(target.graph, await customFieldTypes(tenantId));
    if (errors.length > 0) throw new SimulationValidationError(errors);
    draftGraph = {
      id: DRAFT_ID,
      name: target.graph.name,
      version: { version: 0, rootNodeKey: target.graph.rootNodeKey, nodes: target.graph.nodes.map((n) => ({ key: n.key, conditions: n.conditions, onTrue: n.onTrue, onFalse: n.onFalse })) },
    };
  }

  const where = {
    tenantId,
    ...(scope.emailIds ? { id: { in: scope.emailIds } } : {}),
    ...(scope.mailboxConnectionIds && scope.mailboxConnectionIds.length > 0 ? { mailboxConnectionId: { in: scope.mailboxConnectionIds } } : {}),
    ...(scope.since || scope.until ? { receivedAt: { ...(scope.since ? { gte: scope.since } : {}), ...(scope.until ? { lte: scope.until } : {}) } } : {}),
  };
  const emails = await prisma.email.findMany({ where, orderBy: { receivedAt: "desc" }, take: limit + 1 });
  const truncated = emails.length > limit;
  if (truncated) emails.pop();
  const emailIds = emails.map((e) => e.id);

  const [analyses, decisions] = await Promise.all([
    prisma.analysisResult.findMany({ where: { emailId: { in: emailIds }, status: "ok" }, orderBy: { createdAt: "asc" }, select: { emailId: true, answers: true } }),
    prisma.routingDecision.findMany({ where: { emailId: { in: emailIds }, supersededAt: null }, include: { matchedRule: { select: { name: true } } } }),
  ]);
  // Ascending order + Map overwrite = the latest successful analysis per email, like the live engine.
  const answersByEmail = new Map(analyses.map((a) => [a.emailId, a.answers as Record<string, unknown>]));
  const decisionByEmail = new Map(decisions.map((d) => [d.emailId, d]));

  // Rule targets keep live graph precedence; load each assigned, enabled graph once.
  const assignedGraphByMailbox = new Map<string, GraphForDecision | null>();
  if (target.type !== "graph") {
    const mailboxIds = [...new Set(emails.map((e) => e.mailboxConnectionId))];
    const mailboxes = await prisma.mailboxConnection.findMany({ where: { id: { in: mailboxIds } }, select: { id: true, ruleGraphId: true } });
    const graphIds = [...new Set(mailboxes.map((m) => m.ruleGraphId).filter((id): id is string => Boolean(id)))];
    const graphs = await prisma.ruleGraph.findMany({ where: { id: { in: graphIds }, tenantId, enabled: true } });
    const loaded = new Map<string, GraphForDecision>();
    for (const graph of graphs) loaded.set(graph.id, await loadGraphForDecision(graph));
    for (const m of mailboxes) assignedGraphByMailbox.set(m.id, m.ruleGraphId ? (loaded.get(m.ruleGraphId) ?? null) : null);
  }

  const result: SimulationResult = {
    evaluated: emails.length,
    truncated,
    withoutAnalysis: 0,
    draftMatched: 0,
    decidedByAssignedGraph: 0,
    forcedToReview: 0,
    byDestination: [],
    changed: 0,
    samples: [],
  };
  const byDestination = new Map<string, number>();
  const changedSamples: SimulationSample[] = [];
  const unchangedSamples: SimulationSample[] = [];

  // Phase 22: arrival-time facts, computed exactly as the live engine does.
  const derivedByEmail = await computeDerivedFields(tenantId, emails, businessHours);
  for (const email of emails) {
    const graph = target.type === "graph" ? draftGraph : (assignedGraphByMailbox.get(email.mailboxConnectionId) ?? null);
    const outcome = decideRouting({ email: { ...email, derived: derivedByEmail.get(email.id) }, answers: answersByEmail.get(email.id) ?? null, policy, graph, rules, senderList });
    const after = describeOutcome(outcome);

    if (outcome.kind === "missing_analysis") result.withoutAnalysis += 1;
    if (outcome.kind === "human_review_forced") result.forcedToReview += 1;
    if (target.type === "rule" && outcome.kind === "rule_matched" && outcome.rule.id === DRAFT_ID) result.draftMatched += 1;
    if (target.type === "graph" && outcome.kind === "graph_routed") result.draftMatched += 1;
    if (target.type === "sender_entry" && (outcome.kind === "sender_allowed" || outcome.kind === "sender_blocked") && outcome.entry.id === DRAFT_ID) result.draftMatched += 1;
    if (target.type === "rule" && (outcome.kind === "graph_routed" || outcome.kind === "graph_invalid")) result.decidedByAssignedGraph += 1;
    byDestination.set(after.destinationRef, (byDestination.get(after.destinationRef) ?? 0) + 1);

    const decision = decisionByEmail.get(email.id);
    const before: SimulatedRoute | null = decision
      ? {
          destinationRef: decision.status === "sender_allowed" ? LEFT_ALONE : decision.status === "matched" && decision.destinationRef ? decision.destinationRef : "human_review",
          kind:
            decision.status === "sender_allowed"
              ? "sender_allowed"
              : decision.status === "matched"
                ? decision.senderListPattern
                  ? "sender_blocked"
                  : decision.ruleGraphId
                    ? "graph_routed"
                    : "rule_matched"
                : "not_routed",
          ...(decision.matchedRuleId ? { ruleId: decision.matchedRuleId, ruleName: decision.matchedRule?.name } : {}),
        }
      : null;
    const changed = (before?.destinationRef ?? null) !== after.destinationRef;
    if (changed) result.changed += 1;

    const sample: SimulationSample = { emailId: email.id, subject: email.subject, fromAddress: email.fromAddress, receivedAt: email.receivedAt.toISOString(), before, after, changed };
    if (changed && changedSamples.length < MAX_SAMPLES) changedSamples.push(sample);
    else if (!changed && unchangedSamples.length < MAX_SAMPLES) unchangedSamples.push(sample);
  }

  result.byDestination = [...byDestination.entries()].map(([destinationRef, count]) => ({ destinationRef, count })).sort((a, b) => b.count - a.count);
  // Changes first — they're what the person is deciding about.
  result.samples = [...changedSamples, ...unchangedSamples].slice(0, MAX_SAMPLES);
  return result;
}

/** The pseudo-destination of an allowlisted (VIP) email: nothing happens to it. */
export const LEFT_ALONE = "left_alone";

function describeOutcome(outcome: RoutingOutcome): SimulatedRoute {
  switch (outcome.kind) {
    case "sender_allowed":
      return { destinationRef: LEFT_ALONE, kind: outcome.kind };
    case "sender_blocked":
      return { destinationRef: outcome.destinationRef, kind: outcome.kind };
    case "rule_matched":
      return { destinationRef: outcome.rule.destinationRef, kind: outcome.kind, ruleId: outcome.rule.id, ruleName: outcome.rule.name };
    case "graph_routed":
      return { destinationRef: outcome.destinationRef, kind: outcome.kind, path: outcome.path.map((s) => ({ nodeKey: s.nodeKey, matched: s.matched })) };
    case "graph_invalid":
      return { destinationRef: "human_review", kind: outcome.kind, path: outcome.path.map((s) => ({ nodeKey: s.nodeKey, matched: s.matched })) };
    default:
      return { destinationRef: "human_review", kind: outcome.kind };
  }
}
