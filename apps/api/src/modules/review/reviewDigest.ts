import { prisma } from "../../db/client.js";
import { getSystemSettings } from "../settings/systemSettings.js";
import { isMailerConfigured, sendEmail } from "../email/mailer.js";
import { buildReviewDigestEmail } from "../email/reviewDigestEmail.js";
import { logger } from "../../logger.js";
import { toLocale } from "../i18n/locales.js";
import { createReviewActionToken } from "./reviewActionTokens.js";

const SAMPLE_SIZE = 10;
const REVIEW_PERMISSIONS = ["reviews:read", "reviews:resolve"];

export interface DigestRunResult {
  organizationId: string;
  newItems: number;
  recipients: number;
  sent: number;
}

/**
 * One pass over every organization with digests enabled — called on a timer
 * by the worker (queue/reviewDigestQueue.ts). Each org is only processed once
 * its own interval has elapsed since its last digest. Covers items created
 * after the org's high-water mark (lastReviewDigestAt), then advances it.
 *
 * If SMTP isn't configured the whole pass is skipped WITHOUT advancing any
 * high-water mark, so the first digest after SMTP is set up still reports
 * what arrived in the meantime rather than silently dropping it.
 *
 * Recipients: active members holding reviews:read or reviews:resolve in that
 * org. superAdmins are not auto-included — they'd otherwise get a digest for
 * every organization in the system; one who wants them can be a member.
 */
export async function runReviewDigests(now: Date = new Date()): Promise<DigestRunResult[]> {
  if (!(await isMailerConfigured())) return [];

  const settings = await getSystemSettings();
  const tenants = await prisma.tenant.findMany({ where: { reviewDigestEnabled: true, status: "active" } });
  const results: DigestRunResult[] = [];

  for (const tenant of tenants) {
    const intervalMs = tenant.reviewDigestIntervalMinutes * 60_000;
    if (tenant.lastReviewDigestAt && now.getTime() - tenant.lastReviewDigestAt.getTime() < intervalMs) continue;

    const since = tenant.lastReviewDigestAt ?? new Date(now.getTime() - intervalMs);
    const newItems = await prisma.humanReviewItem.findMany({
      where: { tenantId: tenant.id, status: "open", createdAt: { gt: since, lte: now } },
      orderBy: { createdAt: "desc" },
    });

    if (newItems.length === 0) {
      await prisma.tenant.update({ where: { id: tenant.id }, data: { lastReviewDigestAt: now } });
      results.push({ organizationId: tenant.id, newItems: 0, recipients: 0, sent: 0 });
      continue;
    }

    const [totalOpen, sampleEmails, members] = await Promise.all([
      prisma.humanReviewItem.count({ where: { tenantId: tenant.id, status: "open" } }),
      prisma.email.findMany({
        where: { id: { in: newItems.slice(0, SAMPLE_SIZE).map((i) => i.emailId) } },
        select: { id: true, subject: true, fromAddress: true },
      }),
      prisma.membership.findMany({
        where: { tenantId: tenant.id, status: "active", permissions: { hasSome: REVIEW_PERMISSIONS }, user: { status: "active" } },
        include: { user: { select: { id: true, email: true, locale: true } } },
      }),
    ]);

    const emailById = new Map(sampleEmails.map((e) => [e.id, e]));
    const sample = newItems.slice(0, SAMPLE_SIZE).map((item) => ({
      itemId: item.id,
      subject: emailById.get(item.emailId)?.subject ?? null,
      fromAddress: emailById.get(item.emailId)?.fromAddress ?? "unknown sender",
      reason: item.reason,
    }));
    const actionUrl = (itemId: string, resolution: "spam" | "approved", userId: string) =>
      `${settings.appBaseUrl.replace(/\/$/, "")}/review-action?token=${encodeURIComponent(createReviewActionToken({ tenantId: tenant.id, itemId, resolution, userId }, now))}`;
    let sent = 0;
    for (const member of members) {
      // Phase 23: one-click links only for members who may decide (reviews:resolve), signed for them.
      const canResolve = member.permissions.includes("reviews:resolve");
      const personal = sample.map(({ itemId, ...rest }) => ({
        ...rest,
        ...(canResolve ? { actions: { spamUrl: actionUrl(itemId, "spam", member.user.id), approveUrl: actionUrl(itemId, "approved", member.user.id) } } : {}),
      }));
      const message = buildReviewDigestEmail(tenant.name, newItems.length, totalOpen, personal, `${settings.appBaseUrl}/review`, toLocale(member.user.locale, toLocale(tenant.locale)));
      try {
        await sendEmail({ to: member.user.email, ...message, meta: { kind: "review_digest", tenantId: tenant.id } });
        sent += 1;
      } catch (error) {
        logger.warn({ event: "review_digest_send_failed", organizationId: tenant.id, err: error }, "failed to send review digest");
      }
    }

    // Advance even if some sends failed — retrying the whole digest would
    // re-send to everyone who DID get it. A failed recipient simply sees the
    // items in the app (they're still open) or in the next digest's total.
    await prisma.tenant.update({ where: { id: tenant.id }, data: { lastReviewDigestAt: now } });
    results.push({ organizationId: tenant.id, newItems: newItems.length, recipients: members.length, sent });
  }

  return results;
}
