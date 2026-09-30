import type { RoutingSuggestion } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { recordAuditEvent, AuditEventType } from "../audit/record.js";
import { addSenderEntry } from "../rules/manageSenderList.js";
import { matchSenderList, type SenderListEntryForDecision } from "../rules/senderLists.js";
import { refreshRuleSuggestions } from "./ruleSuggestions.js";

/**
 * Learning from Human Review (Phase 16). People resolve review items as
 * "spam" or "approved"; when a sender is consistently resolved the same way,
 * propose putting it on the block or allow list so those emails stop landing
 * in review. A suggestion is only a proposal — nothing changes until someone
 * accepts it.
 *
 *   window      resolutions from the last 30 days
 *   evidence    at least MIN_RESOLVED resolved emails from the sender
 *   agreement   at least 90% of them resolved the same way
 *   domains     suggested instead of single addresses when 2+ different
 *               addresses from one domain agree — never for public mail
 *               providers (blocking @gmail.com would block everyone)
 *   dismissed   not suggested again for 90 days
 */
/** Sender-level suggestions (this file). Subject-level "rule" suggestions: ruleSuggestions.ts. */
const SENDER_KINDS = ["allow", "block"];

export const SUGGESTION_WINDOW_DAYS = 30;
export const MIN_RESOLVED = 5;
export const AGREEMENT = 0.9;
export const DISMISS_QUIET_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Shared mailbox providers: a domain suggestion here would cover unrelated people. */
export const PUBLIC_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.net", "gmx.de",
  "mail.com", "mail.ru", "yandex.com", "yandex.ru", "zoho.com", "hotmail.com.tr", "outlook.com.tr", "yahoo.com.tr",
]);

interface Tally {
  spam: number;
  approved: number;
  addresses: Set<string>;
}

interface Candidate {
  kind: "allow" | "block";
  pattern: string;
  spam: number;
  approved: number;
}

function verdict(t: Tally): "allow" | "block" | null {
  const resolved = t.spam + t.approved;
  if (resolved < MIN_RESOLVED) return null;
  if (t.spam / resolved >= AGREEMENT) return "block";
  if (t.approved / resolved >= AGREEMENT) return "allow";
  return null;
}

/** Recomputes one organization's open suggestions. Returns the ones now open. */
export async function refreshSuggestions(tenantId: string, now: Date = new Date()): Promise<RoutingSuggestion[]> {
  const items = await prisma.humanReviewItem.findMany({
    // Only people's decisions are evidence: status "resolved" (never
    // "superseded", which reprocessing uses) AND an explicit spam/approved.
    where: { tenantId, status: "resolved", resolution: { in: ["spam", "approved"] }, resolvedAt: { gte: new Date(now.getTime() - SUGGESTION_WINDOW_DAYS * DAY_MS) } },
    select: { resolution: true, email: { select: { fromAddress: true } } },
  });

  const byAddress = new Map<string, Tally>();
  const byDomain = new Map<string, Tally>();
  for (const item of items) {
    const address = item.email.fromAddress.trim().toLowerCase();
    const domain = address.split("@")[1] ?? "";
    for (const [map, key] of [[byAddress, address], [byDomain, domain]] as const) {
      if (!key) continue;
      const tally = map.get(key) ?? { spam: 0, approved: 0, addresses: new Set<string>() };
      if (item.resolution === "spam") tally.spam += 1;
      else tally.approved += 1;
      tally.addresses.add(address);
      map.set(key, tally);
    }
  }

  const candidates: Candidate[] = [];
  const coveredDomains = new Map<string, "allow" | "block">();
  for (const [domain, tally] of byDomain) {
    if (PUBLIC_MAIL_DOMAINS.has(domain) || tally.addresses.size < 2) continue;
    const kind = verdict(tally);
    if (!kind) continue;
    candidates.push({ kind, pattern: `@${domain}`, spam: tally.spam, approved: tally.approved });
    coveredDomains.set(domain, kind);
  }
  for (const [address, tally] of byAddress) {
    const kind = verdict(tally);
    if (!kind || coveredDomains.get(address.split("@")[1] ?? "") === kind) continue;
    candidates.push({ kind, pattern: address, spam: tally.spam, approved: tally.approved });
  }

  const [listRows, existing] = await Promise.all([
    prisma.senderListEntry.findMany({ where: { tenantId }, select: { id: true, kind: true, pattern: true } }),
    prisma.routingSuggestion.findMany({ where: { tenantId, kind: { in: SENDER_KINDS } } }),
  ]);
  const list = listRows as SenderListEntryForDecision[];
  const existingByPattern = new Map(existing.map((s) => [s.pattern, s]));
  const keep = new Set<string>();

  for (const c of candidates) {
    // Already decided by a person: an entry covering this sender exists (either kind).
    const probe = c.pattern.startsWith("@") ? `someone${c.pattern}` : c.pattern;
    if (list.some((e) => e.pattern === c.pattern) || matchSenderList(list, probe)) continue;

    const prior = existingByPattern.get(c.pattern);
    if (prior?.status === "accepted") continue;
    if (prior?.status === "dismissed" && prior.decidedAt && now.getTime() - prior.decidedAt.getTime() < DISMISS_QUIET_DAYS * DAY_MS) continue;

    keep.add(c.pattern);
    const data = { kind: c.kind, resolvedCount: c.spam + c.approved, spamCount: c.spam, approvedCount: c.approved };
    if (prior) await prisma.routingSuggestion.update({ where: { id: prior.id }, data: { ...data, status: "open", decidedBy: null, decidedAt: null } });
    else await prisma.routingSuggestion.create({ data: { tenantId, pattern: c.pattern, ...data } });
  }

  // Open suggestions whose evidence no longer holds are withdrawn (sender kinds only;
  // subject-level rule suggestions are managed by ruleSuggestions.ts).
  await prisma.routingSuggestion.deleteMany({ where: { tenantId, kind: { in: SENDER_KINDS }, status: "open", pattern: { notIn: [...keep] } } });
  return prisma.routingSuggestion.findMany({ where: { tenantId, kind: { in: SENDER_KINDS }, status: "open" }, orderBy: { resolvedCount: "desc" } });
}

/** Maintenance tick: every active organization. */
export async function refreshAllSuggestions(now: Date = new Date()): Promise<number> {
  const tenants = await prisma.tenant.findMany({ where: { status: "active" }, select: { id: true } });
  let open = 0;
  for (const t of tenants) {
    open += (await refreshSuggestions(t.id, now)).length;
    open += (await refreshRuleSuggestions(t.id, now)).length;
  }
  return open;
}

export async function listOpenSuggestions(tenantId: string): Promise<RoutingSuggestion[]> {
  return prisma.routingSuggestion.findMany({ where: { tenantId, kind: { in: SENDER_KINDS }, status: "open" }, orderBy: { resolvedCount: "desc" } });
}

export class SuggestionError extends Error {}

/** Puts the sender on the suggested list. */
export async function acceptSuggestion(tenantId: string, id: string, actor: string | undefined): Promise<RoutingSuggestion> {
  const suggestion = await prisma.routingSuggestion.findFirst({ where: { id, tenantId, status: "open", kind: { in: SENDER_KINDS } } });
  if (!suggestion) throw new SuggestionError("This suggestion is no longer open.");
  await addSenderEntry(
    tenantId,
    {
      kind: suggestion.kind as "allow" | "block",
      pattern: suggestion.pattern,
      note: `Suggested from Human Review: ${suggestion.kind === "block" ? suggestion.spamCount : suggestion.approvedCount} of ${suggestion.resolvedCount} marked ${suggestion.kind === "block" ? "spam" : "approved"}`,
      source: "suggestion",
    },
    actor,
  );
  const updated = await prisma.routingSuggestion.update({ where: { id }, data: { status: "accepted", decidedBy: actor ?? null, decidedAt: new Date() } });
  await recordAuditEvent(prisma, { tenantId, eventType: AuditEventType.ROUTING_SUGGESTION_ACCEPTED, actor: actor ?? "system", payload: { suggestionId: id, kind: suggestion.kind, pattern: suggestion.pattern } });
  return updated;
}

export async function dismissSuggestion(tenantId: string, id: string, actor: string | undefined): Promise<RoutingSuggestion> {
  const suggestion = await prisma.routingSuggestion.findFirst({ where: { id, tenantId, status: "open" } });
  if (!suggestion) throw new SuggestionError("This suggestion is no longer open.");
  const updated = await prisma.routingSuggestion.update({ where: { id }, data: { status: "dismissed", decidedBy: actor ?? null, decidedAt: new Date() } });
  await recordAuditEvent(prisma, { tenantId, eventType: AuditEventType.ROUTING_SUGGESTION_DISMISSED, actor: actor ?? "system", payload: { suggestionId: id, kind: suggestion.kind, pattern: suggestion.pattern } });
  return updated;
}
