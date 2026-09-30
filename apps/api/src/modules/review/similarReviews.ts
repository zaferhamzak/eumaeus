import type { HumanReviewItem } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { resolveReviewItem, type ReviewResolution } from "./resolveReview.js";
import { subjectWords } from "./ruleSuggestions.js";
import { PUBLIC_MAIL_DOMAINS } from "./suggestions.js";

/**
 * Phase 23: decide many open review items at once — the other open items from
 * the same sender (the domain, or the address for public mail providers), and
 * optionally only those whose subject shares a word with this one. Each item
 * is resolved (and audited) individually, exactly as if decided one by one.
 */
export const MAX_SIMILAR = 200;

export interface SimilarItems {
  sender: string;
  /** Words of this item's subject a person can narrow by. */
  words: string[];
  word: string | null;
  items: Array<{ id: string; emailId: string; subject: string | null; fromAddress: string; createdAt: string }>;
  truncated: boolean;
}

function senderOf(address: string): { key: string; isAddress: boolean } {
  const a = address.trim().toLowerCase();
  const domain = a.split("@")[1] ?? "";
  return !domain || PUBLIC_MAIL_DOMAINS.has(domain) ? { key: a, isAddress: true } : { key: domain, isAddress: false };
}

export async function findSimilarOpenItems(tenantId: string, itemId: string, word?: string): Promise<SimilarItems | null> {
  const item = await prisma.humanReviewItem.findFirst({ where: { id: itemId, tenantId }, include: { email: { select: { fromAddress: true, subject: true } } } });
  if (!item) return null;
  const sender = senderOf(item.email.fromAddress);
  const words = subjectWords(item.email.subject);
  const narrowed = word && words.includes(word) ? word : null;
  const rows = await prisma.humanReviewItem.findMany({
    where: {
      tenantId,
      status: "open",
      id: { not: item.id },
      email: {
        ...(sender.isAddress ? { fromAddress: { equals: sender.key, mode: "insensitive" } } : { fromAddress: { endsWith: `@${sender.key}`, mode: "insensitive" } }),
        ...(narrowed ? { subject: { contains: narrowed, mode: "insensitive" } } : {}),
      },
    },
    include: { email: { select: { subject: true, fromAddress: true } } },
    orderBy: { createdAt: "desc" },
    take: MAX_SIMILAR + 1,
  });
  const truncated = rows.length > MAX_SIMILAR;
  return {
    sender: sender.key,
    words,
    word: narrowed,
    truncated,
    items: rows.slice(0, MAX_SIMILAR).map((r) => ({ id: r.id, emailId: r.emailId, subject: r.email.subject, fromAddress: r.email.fromAddress, createdAt: r.createdAt.toISOString() })),
  };
}

/** Resolves each listed open item of the organization; unknown or already-closed ids are reported, not errors. */
export async function resolveMany(tenantId: string, itemIds: string[], resolution: ReviewResolution, actor: string): Promise<{ resolved: number; skipped: number; items: HumanReviewItem[] }> {
  const ids = [...new Set(itemIds)].slice(0, MAX_SIMILAR);
  const open = await prisma.humanReviewItem.findMany({ where: { tenantId, id: { in: ids }, status: "open" }, select: { id: true } });
  const items: HumanReviewItem[] = [];
  for (const { id } of open) {
    const r = await resolveReviewItem(tenantId, id, resolution, actor);
    if (r) items.push(r);
  }
  return { resolved: items.length, skipped: ids.length - items.length, items };
}
