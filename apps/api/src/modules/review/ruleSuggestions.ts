import type { RoutingSuggestion } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { recordAuditEvent, AuditEventType } from "../audit/record.js";
import { createRule } from "../rules/manageRules.js";
import { assessRuleChange, type RuleImpact } from "../rules/ruleImpact.js";
import { foldForMatch, type ConditionNode } from "../rules/conditions.js";
import { PUBLIC_MAIL_DOMAINS } from "./suggestions.js";

/**
 * Rule suggestions from Human Review, by SUBJECT within a sender — the level
 * below allow/block suggestions (suggestions.ts). One sender can send very
 * different things (an account-security notice and a "wants to follow you"
 * from the same instagram.com address); allowing or blocking the whole sender
 * would treat them alike. Here, a sender's resolved emails are split by the
 * subject words they share, and a group whose people all decided the same way
 * becomes a draft RULE: `sender AND subject contains <word>` (+ the Jev
 * category when the group agrees on it), with a destination, a priority and
 * the number of recent emails it would affect.
 *
 * Evidence is the same as for allow/block suggestions — only people's
 * decisions (status "resolved" with spam/approved, never reprocessing's
 * "superseded"), last 30 days — but a narrower group needs less of it:
 *   MIN_GROUP resolved emails sharing the word, AGREEMENT of them decided alike.
 * The body is never used (conditions can't read it either); subjects are
 * reduced to words: lowercased, digits, addresses and @handles removed, short
 * and common words dropped, and a leading "username," greeting ignored.
 *
 * Stored as RoutingSuggestion kind "rule", pattern "rule:<sender>:<word>:<kind>",
 * so accepting and dismissing use the existing suggestion lifecycle and no new
 * table; the draft itself is recomputed when listed. Accepting creates the rule
 * through the normal path, after the rule impact check; the rule can be
 * deleted like any other if the suggestion was wrong.
 */
export const RULE_SUGGESTION_KIND = "rule";
export const MIN_GROUP = 3;
export const AGREEMENT = 0.9;
const WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const DISMISS_QUIET_DAYS = 90;

// Folded like subjects are, so "için" / "hesabınızla" match their folded forms.
const STOPWORDS = new Set<string>(([
  // en
  "the", "and", "for", "you", "your", "with", "from", "this", "that", "are", "has", "have", "was", "our", "new", "now", "get", "can", "will", "not", "all", "about", "more", "just", "into", "out", "how", "what", "who", "its", "it's", "been", "back", "made", "easy",
  // tr
  "ve", "ile", "için", "bir", "bu", "şu", "da", "de", "mi", "mı", "mu", "mü", "size", "sizi", "sizin", "senin", "seni", "hesabınızla", "ilgili", "olarak", "gibi", "daha", "çok", "yeni", "her", "ya", "veya", "ama", "ne", "nasıl", "var", "yok", "olan", "etmek", "eden", "istiyor",
] as string[]).map((w) => foldForMatch(w)));

/** The words of a subject that can carry meaning for grouping. */
export function subjectWords(subject: string | null): string[] {
  if (!subject) return [];
  // The same folding "contains" uses, so a suggested keyword always matches its emails.
  const text = foldForMatch(subject)
    .replace(/^[\p{L}\p{N}._-]{2,40},\s*/u, "") // "ornekhesap_istanbul, ..." greeting
    .replace(/[\w.+-]+@[\w.-]+/g, " ")
    .replace(/@\w+/g, " ")
    .replace(/\p{N}+/gu, " ");
  const words = text.match(/\p{L}{3,}/gu) ?? [];
  return [...new Set(words.filter((w) => !STOPWORDS.has(w)))];
}

interface Resolved {
  emailId: string;
  sender: string;
  words: string[];
  resolution: "spam" | "approved";
  category: string | null;
}

export interface RuleSuggestionDraft {
  name: string;
  priority: number;
  conditions: ConditionNode;
  /** null when no destination could be inferred — the person picks one when accepting. */
  destinationRef: string | null;
  /** Emails from the last 30 days the conditions match. */
  affected: number;
}

export interface RuleSuggestionView {
  suggestion: RoutingSuggestion;
  sender: string;
  word: string;
  decision: "spam" | "approved";
  draft: RuleSuggestionDraft;
}

function senderKey(address: string): string {
  const a = address.trim().toLowerCase();
  const domain = a.split("@")[1] ?? "";
  // A shared mail provider's domain would cover unrelated people — group by address there.
  return !domain || PUBLIC_MAIL_DOMAINS.has(domain) ? a : domain;
}

export function parseRulePattern(pattern: string): { sender: string; word: string; decision: "spam" | "approved" } | null {
  const m = /^rule:([^:]+):([^:]+):(spam|approved)$/.exec(pattern);
  return m ? { sender: m[1]!, word: m[2]!, decision: m[3] as "spam" | "approved" } : null;
}

function conditionsFor(sender: string, word: string, category: string | null): ConditionNode {
  const children: ConditionNode[] = [
    sender.includes("@") ? { field: "sender.address", op: "==", value: sender } : { field: "sender.domain", op: "==", value: sender },
    { field: "subject", op: "contains", value: word },
  ];
  if (category) children.push({ field: "answers.category", op: "==", value: category });
  return { op: "AND", children };
}

/** Groups one sender's resolved emails by shared subject words: greedily, the word covering the most emails first. */
export function groupBySubject(items: Resolved[]): Array<{ word: string; items: Resolved[] }> {
  const groups: Array<{ word: string; items: Resolved[] }> = [];
  let remaining = items;
  for (;;) {
    const counts = new Map<string, Resolved[]>();
    for (const it of remaining) for (const w of it.words) counts.set(w, [...(counts.get(w) ?? []), it]);
    // Most emails covered first; on a tie the longer (usually more specific) word, then alphabetical for stability.
    const best = [...counts.entries()].filter(([, v]) => v.length >= MIN_GROUP).sort((a, b) => b[1].length - a[1].length || b[0].length - a[0].length || a[0].localeCompare(b[0]))[0];
    if (!best) return groups;
    groups.push({ word: best[0], items: best[1] });
    const taken = new Set(best[1].map((i) => i.emailId));
    remaining = remaining.filter((i) => !taken.has(i.emailId));
  }
}

async function resolvedEvidence(tenantId: string, now: Date): Promise<Resolved[]> {
  const rows = await prisma.humanReviewItem.findMany({
    where: { tenantId, status: "resolved", resolution: { in: ["spam", "approved"] }, resolvedAt: { gte: new Date(now.getTime() - WINDOW_DAYS * DAY_MS) } },
    select: { resolution: true, email: { select: { id: true, fromAddress: true, subject: true } } },
  });
  const analyses = await prisma.analysisResult.findMany({
    where: { emailId: { in: rows.map((r) => r.email.id) }, status: "ok" },
    orderBy: { createdAt: "asc" },
    select: { emailId: true, answers: true },
  });
  const categoryBy = new Map(analyses.map((a) => [a.emailId, ((a.answers as Record<string, { choice?: unknown }> | null)?.category?.choice as string | undefined) ?? null]));
  return rows.map((r) => ({
    emailId: r.email.id,
    sender: senderKey(r.email.fromAddress),
    words: subjectWords(r.email.subject),
    resolution: r.resolution as "spam" | "approved",
    category: categoryBy.get(r.email.id) ?? null,
  }));
}

/** Recomputes the organization's open rule suggestions. */
/**
 * The organization's own name and mailbox domains show up in the subjects of
 * mail sent TO it ("… Acme …") — they don't tell one kind of email from
 * another, so they never become a suggestion's keyword.
 */
async function ownWords(tenantId: string): Promise<Set<string>> {
  const [tenant, mailboxes] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, slug: true } }),
    prisma.mailboxConnection.findMany({ where: { tenantId }, select: { emailAddress: true } }),
  ]);
  const text = [tenant.name, tenant.slug ?? "", ...mailboxes.flatMap((m) => m.emailAddress.split(/[@.]/))].join(" ");
  return new Set(subjectWords(text));
}

export async function refreshRuleSuggestions(tenantId: string, now: Date = new Date()): Promise<RoutingSuggestion[]> {
  const own = await ownWords(tenantId);
  const evidence = (await resolvedEvidence(tenantId, now)).map((e) => ({ ...e, words: e.words.filter((w) => !own.has(w)) }));
  const bySender = new Map<string, Resolved[]>();
  for (const e of evidence) bySender.set(e.sender, [...(bySender.get(e.sender) ?? []), e]);

  const existing = await prisma.routingSuggestion.findMany({ where: { tenantId, kind: RULE_SUGGESTION_KIND } });
  const existingBy = new Map(existing.map((s) => [s.pattern, s]));
  const keep = new Set<string>();

  for (const [sender, items] of bySender) {
    for (const group of groupBySubject(items)) {
      const spam = group.items.filter((i) => i.resolution === "spam").length;
      const approved = group.items.length - spam;
      const decision = spam / group.items.length >= AGREEMENT ? "spam" : approved / group.items.length >= AGREEMENT ? "approved" : null;
      if (!decision) continue;
      const pattern = `rule:${sender}:${group.word}:${decision}`;
      const prior = existingBy.get(pattern);
      if (prior?.status === "accepted") continue;
      if (prior?.status === "dismissed" && prior.decidedAt && now.getTime() - prior.decidedAt.getTime() < DISMISS_QUIET_DAYS * DAY_MS) continue;
      keep.add(pattern);
      const data = { kind: RULE_SUGGESTION_KIND, resolvedCount: group.items.length, spamCount: spam, approvedCount: approved };
      if (prior) await prisma.routingSuggestion.update({ where: { id: prior.id }, data: { ...data, status: "open", decidedBy: null, decidedAt: null } });
      else await prisma.routingSuggestion.create({ data: { tenantId, pattern, ...data } });
    }
  }
  await prisma.routingSuggestion.deleteMany({ where: { tenantId, kind: RULE_SUGGESTION_KIND, status: "open", pattern: { notIn: [...keep] } } });
  return prisma.routingSuggestion.findMany({ where: { tenantId, kind: RULE_SUGGESTION_KIND, status: "open" }, orderBy: { resolvedCount: "desc" } });
}

/** The draft rule behind a suggestion: conditions, a destination, a free priority, and how many recent emails it matches. */
export async function draftFor(tenantId: string, suggestion: RoutingSuggestion, now: Date = new Date()): Promise<RuleSuggestionView | null> {
  const parsed = parseRulePattern(suggestion.pattern);
  if (!parsed) return null;
  const { sender, word, decision } = parsed;

  // The group's agreed Jev category narrows the rule further (only when nearly all agree).
  const evidence = (await resolvedEvidence(tenantId, now)).filter((e) => e.sender === sender && e.words.includes(word));
  const categories = new Map<string, number>();
  for (const e of evidence) if (e.category) categories.set(e.category, (categories.get(e.category) ?? 0) + 1);
  const [topCategory, topCount] = [...categories.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  const category = topCategory && evidence.length > 0 && topCount / evidence.length >= AGREEMENT ? topCategory : null;
  const conditions = conditionsFor(sender, word, category);

  // Recent emails the conditions match, and where rules sent those emails.
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const senderFilter = sender.includes("@") ? { fromAddress: { equals: sender, mode: "insensitive" as const } } : { fromAddress: { endsWith: `@${sender}`, mode: "insensitive" as const } };
  const recent = await prisma.email.findMany({ where: { tenantId, receivedAt: { gte: since }, ...senderFilter, subject: { contains: word, mode: "insensitive" } }, select: { id: true } });
  const decisions = await prisma.routingDecision.findMany({ where: { emailId: { in: recent.map((e) => e.id) }, supersededAt: null, status: "matched" }, select: { destinationRef: true, matchedRule: { select: { priority: true } } } });

  let destinationRef: string | null = null;
  if (decision === "spam") {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { blockDestinationRef: true } });
    const junk = await prisma.destination.findFirst({ where: { tenantId, name: { in: ["Junk", "Spam", "Gereksiz", "junk", "spam"] } }, select: { name: true } });
    destinationRef = tenant.blockDestinationRef || junk?.name || null;
  } else {
    // Approved: keep sending them where rules already send most of them, if anywhere.
    const counts = new Map<string, number>();
    for (const d of decisions) if (d.destinationRef && d.destinationRef !== "human_review") counts.set(d.destinationRef, (counts.get(d.destinationRef) ?? 0) + 1);
    destinationRef = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }

  // Priority: just before the rule that takes most of these emails today (so the suggestion actually applies), else after all rules.
  const active = await prisma.rule.findMany({ where: { tenantId, enabled: true, deactivatedAt: null }, select: { priority: true } });
  const used = new Set(active.map((r) => r.priority));
  const takers = decisions.map((d) => d.matchedRule?.priority).filter((p): p is number => typeof p === "number");
  let priority = takers.length > 0 ? Math.min(...takers) - 1 : Math.max(0, ...active.map((r) => r.priority)) + 10;
  while (used.has(priority)) priority -= 1;

  return {
    suggestion,
    sender,
    word,
    decision,
    draft: { name: `${decision === "spam" ? "Spam" : "Approved"}: ${sender} — “${word}”`, priority, conditions, destinationRef, affected: recent.length },
  };
}

export async function listRuleSuggestions(tenantId: string): Promise<RuleSuggestionView[]> {
  const open = await prisma.routingSuggestion.findMany({ where: { tenantId, kind: RULE_SUGGESTION_KIND, status: "open" }, orderBy: { resolvedCount: "desc" } });
  const views = await Promise.all(open.map((s) => draftFor(tenantId, s)));
  return views.filter((v): v is RuleSuggestionView => v !== null);
}

export class RuleSuggestionError extends Error {
  constructor(
    message: string,
    public readonly impact?: RuleImpact,
  ) {
    super(message);
  }
}

/**
 * Creates the suggested rule (the person may override destination, priority
 * or name). Runs the rule impact check first: a draft that would move
 * business mail into a junk-like destination is refused unless confirmed.
 */
export async function acceptRuleSuggestion(
  tenantId: string,
  id: string,
  actor: string | undefined,
  overrides: { destinationRef?: string; priority?: number; name?: string; confirmImpact?: boolean } = {},
): Promise<{ suggestion: RoutingSuggestion; ruleId: string; impact: RuleImpact }> {
  const suggestion = await prisma.routingSuggestion.findFirst({ where: { id, tenantId, kind: RULE_SUGGESTION_KIND, status: "open" } });
  if (!suggestion) throw new RuleSuggestionError("This suggestion is no longer open.");
  const view = await draftFor(tenantId, suggestion);
  if (!view) throw new RuleSuggestionError("This suggestion can't be turned into a rule.");
  const destinationRef = overrides.destinationRef ?? view.draft.destinationRef;
  if (!destinationRef) throw new RuleSuggestionError("Choose where these emails should go.");
  const rule = { name: overrides.name ?? view.draft.name, priority: overrides.priority ?? view.draft.priority, destinationRef, conditions: view.draft.conditions };

  const impact = await assessRuleChange(tenantId, { type: "create", rule });
  if (impact.risky.count > 0 && !overrides.confirmImpact) {
    throw new RuleSuggestionError(`This rule would move ${impact.risky.count} email(s) that look like business mail to a junk-like destination. Confirm to create it anyway.`, impact);
  }
  const created = await createRule(tenantId, rule);
  const updated = await prisma.routingSuggestion.update({ where: { id }, data: { status: "accepted", decidedBy: actor ?? null, decidedAt: new Date() } });
  await recordAuditEvent(prisma, { tenantId, eventType: AuditEventType.ROUTING_SUGGESTION_ACCEPTED, actor: actor ?? "system", payload: { suggestionId: id, kind: RULE_SUGGESTION_KIND, pattern: suggestion.pattern, ruleId: created.id } });
  return { suggestion: updated, ruleId: created.id, impact };
}

export async function dismissRuleSuggestion(tenantId: string, id: string, actor: string | undefined): Promise<RoutingSuggestion> {
  const suggestion = await prisma.routingSuggestion.findFirst({ where: { id, tenantId, kind: RULE_SUGGESTION_KIND, status: "open" } });
  if (!suggestion) throw new RuleSuggestionError("This suggestion is no longer open.");
  const updated = await prisma.routingSuggestion.update({ where: { id }, data: { status: "dismissed", decidedBy: actor ?? null, decidedAt: new Date() } });
  await recordAuditEvent(prisma, { tenantId, eventType: AuditEventType.ROUTING_SUGGESTION_DISMISSED, actor: actor ?? "system", payload: { suggestionId: id, kind: RULE_SUGGESTION_KIND, pattern: suggestion.pattern } });
  return updated;
}
