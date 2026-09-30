import { prisma } from "../../db/client.js";
import { decideRouting, type GraphForDecision, type RoutingOutcome, type RuleForDecision } from "./decideRouting.js";
import { evaluateCondition, type ConditionNode } from "./conditions.js";
import { buildEvaluationContext } from "./evaluationContext.js";
import { validateRule, type RuleInput } from "./validateRule.js";
import { loadGraphForDecision, loadSenderList } from "./evaluateRulesForEmail.js";
import { customFieldTypes } from "./customFields.js";
import { computeDerivedFields } from "./derivedFields.js";

/**
 * What a rule change would do, measured BEFORE it is saved: the same decision
 * function the live engine uses (decideRouting — sender lists first, then an
 * assigned graph, then rules by ascending priority, first match wins), run
 * twice over recent emails — once with today's rules, once with the change
 * applied — and compared email by email. Read-only; nothing is written.
 *
 * Comparing against today's rules (not against each email's stored decision)
 * isolates the effect of THIS change from everything else that changed since
 * those emails arrived. How far today's rules drift from the stored
 * decisions is reported separately (`divergence`) — if the simulation and the
 * live history disagree a lot, the numbers deserve a second look.
 *
 * A change is RISKY when it would move an email that looks like real business
 * traffic into a "sink" destination (Junk, spam, trash):
 *   business traffic  customer-related (answers.is_customer_related >= 0.5),
 *                     category customer_message / support / invoice / sales /
 *                     business_opportunity, or an email today's rules send
 *                     to a finance or security destination
 *   sink              a destination whose name or move-to folder looks like
 *                     junk / spam / trash (TR and EN names)
 * Risky changes are refused by the API unless explicitly confirmed.
 */
export const IMPACT_DAYS = 30;
export const IMPACT_MAX_EMAILS = 500;
const MAX_SAMPLES = 15;
const DRAFT_ID = "draft";

const SINK_PATTERN = /junk|spam|trash|bin\b|çöp|cop\b|gereksiz|önemsiz|onemsiz/i;
const PROTECTED_DESTINATION = /finans|finance|fatura|invoice|güvenlik|guvenlik|security|muhasebe|accounting/i;
const BUSINESS_CATEGORIES = new Set(["customer_message", "support", "invoice", "sales", "business_opportunity"]);

type DestinationWithChannels = { name: string; channels: Array<{ type: string; config: unknown }> };

function sinkNames(destinations: DestinationWithChannels[]): Set<string> {
  return new Set(
    destinations
      .filter((d) => SINK_PATTERN.test(d.name) || d.channels.some((c) => c.type === "archive" && SINK_PATTERN.test(String((c.config as { folder?: unknown }).folder ?? ""))))
      .map((d) => d.name),
  );
}

/** The organization's junk-like destinations (by name or move-to folder) — shared with corrections. */
export async function sinkDestinations(tenantId: string): Promise<Set<string>> {
  return sinkNames(await prisma.destination.findMany({ where: { tenantId }, select: { name: true, channels: { where: { deactivatedAt: null, enabled: true }, select: { type: true, config: true } } } }));
}

export type RuleChange =
  | { type: "create"; rule: RuleInput }
  | { type: "update"; ruleId: string; rule: RuleInput }
  | { type: "delete"; ruleId: string };

export interface ImpactSample {
  emailId: string;
  subject: string | null;
  fromAddress: string;
  receivedAt: string;
  from: string;
  to: string;
  reason?: string;
}

export interface RuleImpact {
  days: number;
  evaluated: number;
  truncated: boolean;
  /** Emails the new/edited rule would take (0 for a delete). */
  draftMatches: number;
  /** Emails the existing version takes today (update/delete; 0 for a create). */
  currentMatches: number;
  /** Emails whose destination would change. */
  changed: number;
  moves: Array<{ from: string; to: string; count: number }>;
  /** Emails the draft's conditions match but an earlier rule (or a list/graph) takes first. */
  shadowedBy: Array<{ by: string; count: number }>;
  risky: { count: number; samples: ImpactSample[] };
  samples: ImpactSample[];
  /** Emails where today's rules, simulated, disagree with the stored decision. */
  divergence: number;
  warnings: string[];
}

export class RuleImpactError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join("; "));
  }
}

function destinationOf(outcome: RoutingOutcome): string {
  switch (outcome.kind) {
    case "sender_allowed":
      return "left_alone";
    case "sender_blocked":
    case "graph_routed":
      return outcome.destinationRef;
    case "rule_matched":
      return outcome.rule.destinationRef;
    default:
      return "human_review";
  }
}

function winnerOf(outcome: RoutingOutcome): string {
  switch (outcome.kind) {
    case "rule_matched":
      return `rule "${outcome.rule.name}"`;
    case "sender_allowed":
    case "sender_blocked":
      return `sender list (${outcome.entry.pattern})`;
    case "graph_routed":
    case "graph_invalid":
      return `rule graph "${outcome.graph.name}"`;
    case "human_review_forced":
      return "Jev's review signal";
    default:
      return "Human Review";
  }
}

function businessReason(answers: Record<string, unknown> | null, currentDestination: string): string | null {
  if (PROTECTED_DESTINATION.test(currentDestination)) return `goes to "${currentDestination}" today`;
  if (!answers) return null;
  const customer = (answers.is_customer_related as { noul?: unknown } | undefined)?.noul;
  if (typeof customer === "number" && customer >= 0.5) return `customer-related (${customer.toFixed(2)})`;
  const category = (answers.category as { choice?: unknown } | undefined)?.choice;
  if (typeof category === "string" && BUSINESS_CATEGORIES.has(category)) return `category ${category}`;
  return null;
}

export async function assessRuleChange(tenantId: string, change: RuleChange, options: { days?: number; limit?: number; now?: Date } = {}): Promise<RuleImpact> {
  const days = options.days ?? IMPACT_DAYS;
  const limit = Math.min(options.limit ?? IMPACT_MAX_EMAILS, IMPACT_MAX_EMAILS);
  const now = options.now ?? new Date();

  const [activeRows, tenant, senderList, destinations] = await Promise.all([
    prisma.rule.findMany({ where: { tenantId, enabled: true, deactivatedAt: null } }),
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { humanReviewSignalEnabled: true, humanReviewSignalThreshold: true, blockDestinationRef: true, businessHours: true } }),
    loadSenderList(tenantId),
    prisma.destination.findMany({ where: { tenantId }, select: { name: true, channels: { where: { deactivatedAt: null, enabled: true }, select: { type: true, config: true } } } }),
  ]);
  const { businessHours, ...policy } = tenant;
  const current: RuleForDecision[] = activeRows;

  // The proposed rule set.
  let proposed: RuleForDecision[];
  let draft: RuleForDecision | null = null;
  let existing: RuleForDecision | undefined;
  if (change.type === "create" || change.type === "update") {
    const errors = validateRule(change.rule, await customFieldTypes(tenantId));
    if (change.type === "update") {
      existing = current.find((r) => r.id === change.ruleId);
      if (!existing) errors.push(`rule ${change.ruleId} is not an active rule of this organization`);
    }
    const others = current.filter((r) => r.id !== (change.type === "update" ? change.ruleId : undefined));
    const clash = others.find((r) => r.priority === change.rule.priority);
    if (clash) errors.push(`priority ${change.rule.priority} is already used by rule "${clash.name}"`);
    if (errors.length > 0) throw new RuleImpactError(errors);
    draft = { id: DRAFT_ID, version: 0, name: change.rule.name, priority: change.rule.priority, conditions: change.rule.conditions, destinationRef: change.rule.destinationRef };
    proposed = [...others, draft];
  } else {
    existing = current.find((r) => r.id === change.ruleId);
    if (!existing) throw new RuleImpactError([`rule ${change.ruleId} is not an active rule of this organization`]);
    proposed = current.filter((r) => r.id !== change.ruleId);
  }

  // Recent emails, newest first (a bounded sample, not the whole history).
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const emails = await prisma.email.findMany({ where: { tenantId, receivedAt: { gte: since } }, orderBy: { receivedAt: "desc" }, take: limit + 1 });
  const truncated = emails.length > limit;
  if (truncated) emails.pop();
  const ids = emails.map((e) => e.id);
  const [analyses, decisions, mailboxes] = await Promise.all([
    prisma.analysisResult.findMany({ where: { emailId: { in: ids }, status: "ok" }, orderBy: { createdAt: "asc" }, select: { emailId: true, answers: true } }),
    prisma.routingDecision.findMany({ where: { emailId: { in: ids }, supersededAt: null }, select: { emailId: true, status: true, destinationRef: true } }),
    prisma.mailboxConnection.findMany({ where: { id: { in: [...new Set(emails.map((e) => e.mailboxConnectionId))] } }, select: { id: true, ruleGraphId: true } }),
  ]);
  const answersBy = new Map(analyses.map((a) => [a.emailId, a.answers as Record<string, unknown>]));
  const storedBy = new Map(decisions.map((d) => [d.emailId, d.status === "sender_allowed" ? "left_alone" : d.status === "matched" && d.destinationRef ? d.destinationRef : "human_review"]));
  const graphIds = [...new Set(mailboxes.map((m) => m.ruleGraphId).filter((g): g is string => Boolean(g)))];
  const graphs = new Map<string, GraphForDecision>();
  for (const g of await prisma.ruleGraph.findMany({ where: { id: { in: graphIds }, tenantId, enabled: true } })) graphs.set(g.id, await loadGraphForDecision(g));
  const graphByMailbox = new Map(mailboxes.map((m) => [m.id, m.ruleGraphId ? (graphs.get(m.ruleGraphId) ?? null) : null]));
  const derivedBy = await computeDerivedFields(tenantId, emails, businessHours);

  const sinks = sinkNames(destinations);

  const impact: RuleImpact = { days, evaluated: emails.length, truncated, draftMatches: 0, currentMatches: 0, changed: 0, moves: [], shadowedBy: [], risky: { count: 0, samples: [] }, samples: [], divergence: 0, warnings: [] };
  const moves = new Map<string, number>();
  const shadowed = new Map<string, number>();

  for (const email of emails) {
    const input = { email: { ...email, derived: derivedBy.get(email.id) }, answers: answersBy.get(email.id) ?? null, policy, graph: graphByMailbox.get(email.mailboxConnectionId) ?? null, senderList };
    const before = decideRouting({ ...input, rules: current });
    const after = decideRouting({ ...input, rules: proposed });
    const from = destinationOf(before);
    const to = destinationOf(after);

    const stored = storedBy.get(email.id);
    if (stored !== undefined && stored !== from) impact.divergence += 1;
    if (existing && before.kind === "rule_matched" && before.rule.id === existing.id) impact.currentMatches += 1;
    if (draft && after.kind === "rule_matched" && after.rule.id === DRAFT_ID) impact.draftMatches += 1;
    if (draft && input.answers && !(after.kind === "rule_matched" && after.rule.id === DRAFT_ID)) {
      const matchesDraft = evaluateCondition(draft.conditions as ConditionNode, buildEvaluationContext(input.email, input.answers)).matched;
      if (matchesDraft) shadowed.set(winnerOf(after), (shadowed.get(winnerOf(after)) ?? 0) + 1);
    }

    if (from === to) continue;
    impact.changed += 1;
    moves.set(`${from}\u0000${to}`, (moves.get(`${from}\u0000${to}`) ?? 0) + 1);
    const sample: ImpactSample = { emailId: email.id, subject: email.subject, fromAddress: email.fromAddress, receivedAt: email.receivedAt.toISOString(), from, to };
    const reason = sinks.has(to) && !sinks.has(from) ? businessReason(input.answers, from) : null;
    if (reason) {
      impact.risky.count += 1;
      if (impact.risky.samples.length < MAX_SAMPLES) impact.risky.samples.push({ ...sample, reason });
    } else if (impact.samples.length < MAX_SAMPLES) {
      impact.samples.push(sample);
    }
  }

  impact.moves = [...moves.entries()].map(([k, count]) => ({ from: k.split("\u0000")[0]!, to: k.split("\u0000")[1]!, count })).sort((a, b) => b.count - a.count);
  impact.shadowedBy = [...shadowed.entries()].map(([by, count]) => ({ by, count })).sort((a, b) => b.count - a.count);
  if (truncated) impact.warnings.push(`Only the newest ${limit} emails of the last ${days} days were checked.`);
  if (impact.evaluated > 0 && impact.divergence / impact.evaluated > 0.1) {
    impact.warnings.push(`For ${impact.divergence} of ${impact.evaluated} emails, today's rules would decide differently from what was recorded — earlier changes, reprocessing or missing analyses; read these numbers with that in mind.`);
  }
  if (draft && impact.draftMatches === 0 && impact.shadowedBy.length > 0) impact.warnings.push("The rule's conditions match emails, but earlier rules take all of them first — check its priority.");
  return impact;
}
