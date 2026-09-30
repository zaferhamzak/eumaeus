import { prisma } from "../../db/client.js";
import { getSystemSettings } from "../settings/systemSettings.js";
import { isMailerConfigured, sendEmail } from "../email/mailer.js";
import { emailText, reviewReason } from "../i18n/emailText.js";
import { toLocale, type Locale } from "../i18n/locales.js";
import { logger } from "../../logger.js";
import type { InlineImage } from "../email/mailer.js";
import { actions, badge, heading, LOGO_IMAGES, mailItem, mailList, paragraph, renderEmail, spacer } from "../email/emailLayout.js";

/**
 * Emailing people about review items assigned to them — batched by the
 * organization's threshold: one email once `assignmentNotifyThreshold` open,
 * not-yet-notified items assigned to that member have gathered (1 = every
 * assignment). Items the member resolved, or that were reassigned, before
 * the threshold was reached drop out and are never mentioned.
 *
 * Runs right after an assignment and again on the review-digest tick (so
 * lowering the threshold, or SMTP coming back after a failed send, takes
 * effect without waiting for another assignment).
 *
 * Claim-then-send: the items are marked notified before the email goes out
 * (so two runs can't both send them) and unmarked if sending fails.
 */
export const MAX_LISTED = 20;

export interface AssignmentNotifyResult {
  sent: boolean;
  items: number;
  reason?: "disabled" | "no_smtp" | "below_threshold" | "no_user" | "send_failed";
}

/** 1.0.2: in the shared email frame; each assigned email is a row linking to its review item. */
export function buildAssignmentEmail(
  organizationName: string,
  items: Array<{ id: string; subject: string | null; fromAddress: string; reason: string }>,
  appBaseUrl: string,
  locale: Locale,
): { subject: string; html: string; text: string; inlineImages: InlineImage[] } {
  const base = appBaseUrl.replace(/\/$/, "");
  const listed = items.slice(0, MAX_LISTED);
  const more = items.length - listed.length;
  const line = (i: (typeof items)[number]) => `${i.subject || emailText(locale, "noSubject")} — ${i.fromAddress} (${reviewReason(locale, i.reason)})`;
  const body = emailText(locale, "assignBody", { count: items.length, org: organizationName });
  const mineUrl = `${base}/review?assigned=me`;
  const moreText = more > 0 ? emailText(locale, "digestMore", { count: more }) : "";
  const subject = emailText(locale, "assignSubject", { count: items.length, org: organizationName });
  return {
    subject,
    text: [body, "", ...listed.map((i) => `• ${line(i)}\n  ${base}/review/${i.id}`), ...(more > 0 ? [moreText] : []), "", `${emailText(locale, "assignOpenMine")}: ${mineUrl}`, "", emailText(locale, "assignFooter")].join("\n"),
    html: renderEmail({
      locale,
      subject,
      preheader: body,
      tone: "accent",
      body: [
        badge(emailText(locale, "assignBadge"), "accent"),
        spacer(16),
        heading(subject),
        paragraph(body),
        mailList(listed.map((i) => mailItem({ subject: i.subject || emailText(locale, "noSubject"), from: i.fromAddress, reason: reviewReason(locale, i.reason), href: `${base}/review/${i.id}` }))),
        more > 0 ? paragraph(moreText) : "",
        actions({ href: mineUrl, label: emailText(locale, "assignOpenMine") }),
      ].join("\n"),
      footer: emailText(locale, "assignFooter"),
    }),
    inlineImages: LOGO_IMAGES,
  };
}

/** Sends one member their assignment email if their pending assigned items reached the threshold. */
export async function notifyAssignee(tenantId: string, userId: string): Promise<AssignmentNotifyResult> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, locale: true, assignmentNotifyEnabled: true, assignmentNotifyThreshold: true } });
  if (!tenant?.assignmentNotifyEnabled) return { sent: false, items: 0, reason: "disabled" };
  const pending = await prisma.humanReviewItem.findMany({
    where: { tenantId, assignedTo: userId, status: "open", assignmentNotifiedAt: null },
    orderBy: [{ assignedAt: "asc" }, { createdAt: "asc" }],
    select: { id: true, emailId: true, reason: true },
  });
  if (pending.length < Math.max(1, tenant.assignmentNotifyThreshold)) return { sent: false, items: pending.length, reason: "below_threshold" };
  if (!(await isMailerConfigured())) return { sent: false, items: pending.length, reason: "no_smtp" };
  const user = await prisma.user.findFirst({ where: { id: userId, status: "active" }, select: { email: true, locale: true } });
  if (!user) return { sent: false, items: pending.length, reason: "no_user" };

  const ids = pending.map((p) => p.id);
  const now = new Date();
  const claimed = await prisma.humanReviewItem.updateMany({ where: { id: { in: ids }, assignmentNotifiedAt: null }, data: { assignmentNotifiedAt: now } });
  if (claimed.count < ids.length) {
    // Another run got (some of) them first; give ours back and let the next run decide.
    await prisma.humanReviewItem.updateMany({ where: { id: { in: ids }, assignmentNotifiedAt: now }, data: { assignmentNotifiedAt: null } });
    return { sent: false, items: pending.length, reason: "below_threshold" };
  }

  const emails = await prisma.email.findMany({ where: { id: { in: pending.map((p) => p.emailId) } }, select: { id: true, subject: true, fromAddress: true } });
  const byId = new Map(emails.map((e) => [e.id, e]));
  const settings = await getSystemSettings();
  const message = buildAssignmentEmail(
    tenant.name,
    pending.map((p) => ({ id: p.id, reason: p.reason, subject: byId.get(p.emailId)?.subject ?? null, fromAddress: byId.get(p.emailId)?.fromAddress ?? "unknown sender" })),
    settings.appBaseUrl,
    toLocale(user.locale, toLocale(tenant.locale)),
  );
  try {
    await sendEmail({ to: user.email, ...message, meta: { kind: "assignment", tenantId } });
    return { sent: true, items: pending.length };
  } catch (error) {
    await prisma.humanReviewItem.updateMany({ where: { id: { in: ids }, assignmentNotifiedAt: now }, data: { assignmentNotifiedAt: null } });
    logger.warn({ event: "assignment_notify_failed", organizationId: tenantId, err: error }, "failed to send assignment email");
    return { sent: false, items: pending.length, reason: "send_failed" };
  }
}

/** The periodic pass: every member of every organization with pending assigned items. */
export async function notifyPendingAssignments(): Promise<number> {
  const groups = await prisma.humanReviewItem.groupBy({
    by: ["tenantId", "assignedTo"],
    where: { status: "open", assignedTo: { not: null }, assignmentNotifiedAt: null, tenant: { assignmentNotifyEnabled: true } },
  });
  let sent = 0;
  for (const g of groups) {
    if (!g.assignedTo) continue;
    const result = await notifyAssignee(g.tenantId, g.assignedTo);
    if (result.sent) sent += 1;
  }
  return sent;
}
