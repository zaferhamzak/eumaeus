import { createHash } from "node:crypto";
import { prisma } from "../../db/client.js";
import { logger } from "../../logger.js";
import { getSenderIdentity, MailerNotConfiguredError, sendMailMessage } from "../email/mailer.js";
import { buildNotifyEmail, MAX_NOTICE_LISTED, type NotifyEmailInfo } from "../email/notifyEmail.js";
import { FORWARDED_HEADER } from "../email/forwardHeaders.js";
import { getSystemSettings } from "../settings/systemSettings.js";
import { htmlToText } from "../email/htmlText.js";
import { toLocale, type Locale } from "../i18n/locales.js";
import { FORWARD_EXECUTOR_TIMEOUT_MS } from "./idempotency.js";
import { checkDailyLimit, resolveDeliverableRecipients } from "./forwardPolicy.js";
import { monitoredAddresses } from "./manageDestinations.js";
import { SendTimeoutError, withTimeout, type ForwardSender } from "./executors/forwardExecutor.js";
import { classifySmtpError } from "./executors/smtpErrors.js";
import type { DestinationExecutor, ExecutionContext, ExecutionOutcome } from "./executors/types.js";
import { DEFAULT_DIGEST_INTERVAL_MINUTES, DEFAULT_NOTIFY_THROTTLE_MINUTES, type EmailNotifyChannelConfig, type ForwardChannelConfig } from "./types.js";

/**
 * 1.2 (O): the "email_notify" channel — a rule routed an email here, so tell
 * people. See types.ts EmailNotifyChannelConfig for the settings.
 *
 * Guardrails, all checked when the notice is sent:
 *   - never about a copy Eumaeus itself sent (loop);
 *   - never to a mailbox Eumaeus watches (the notice would come back as mail);
 *   - outside addresses only once confirmed, and only on the organization's
 *     forwarding allowlist (same rules as forwarding);
 *   - notices count toward the organization's daily outgoing limit.
 */

export interface NotifyRecipient {
  address: string;
  locale: Locale;
}

export interface NotifySkip {
  address: string;
  reason: "unverified" | "domain_not_allowed" | "monitored_mailbox";
}

export async function resolveNotifyRecipients(tenantId: string, config: EmailNotifyChannelConfig): Promise<{ recipients: NotifyRecipient[]; skipped: NotifySkip[] }> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { locale: true } });
  const orgLocale = toLocale(tenant.locale);
  const byAddress = new Map<string, NotifyRecipient>();
  const skipped: NotifySkip[] = [];

  if (config.members?.length || config.permission) {
    const memberships = await prisma.membership.findMany({
      where: {
        tenantId,
        status: "active",
        user: { status: "active" },
        OR: [...(config.members?.length ? [{ userId: { in: config.members } }] : []), ...(config.permission ? [{ permissions: { has: config.permission } }] : [])],
      },
      select: { user: { select: { email: true, locale: true } } },
    });
    const monitored = await monitoredAddresses(tenantId);
    for (const { user } of memberships) {
      const address = user.email.toLowerCase();
      if (monitored.has(address)) skipped.push({ address, reason: "monitored_mailbox" });
      else byAddress.set(address, { address, locale: toLocale(user.locale, orgLocale) });
    }
  }
  if (config.addresses?.length) {
    const outside = await resolveDeliverableRecipients(tenantId, { to: config.addresses } as ForwardChannelConfig);
    for (const address of outside.recipients.to) if (!byAddress.has(address)) byAddress.set(address, { address, locale: orgLocale });
    skipped.push(...outside.skipped);
  }
  return { recipients: [...byAddress.values()], skipped };
}

async function loadEmailInfo(emailIds: string[]): Promise<NotifyEmailInfo[]> {
  const [emails, analyses] = await Promise.all([
    prisma.email.findMany({ where: { id: { in: emailIds } }, include: { mailboxConnection: { select: { emailAddress: true } } }, orderBy: { receivedAt: "asc" } }),
    prisma.analysisResult.findMany({ where: { emailId: { in: emailIds }, status: "ok" }, orderBy: { createdAt: "desc" }, select: { emailId: true, answers: true } }),
  ]);
  const signals = new Map<string, Record<string, unknown>>();
  for (const a of analyses) if (!signals.has(a.emailId) && a.answers) signals.set(a.emailId, a.answers as Record<string, unknown>);
  return emails.map((e) => ({
    id: e.id,
    subject: e.subject,
    fromAddress: e.fromAddress,
    senderName: e.senderName,
    mailbox: e.mailboxConnection.emailAddress,
    receivedAt: e.receivedAt,
    signals: signals.get(e.id),
    // An HTML-only email still gets an excerpt.
    textBody: e.textBody || (e.htmlBody ? htmlToText(e.htmlBody) : null),
  }));
}

function businessHoursTimeZone(businessHours: unknown): string | undefined {
  const zone = (businessHours as { timeZone?: unknown } | null)?.timeZone;
  return typeof zone === "string" && zone ? zone : undefined;
}

function permanent(errorClass: string, errorMessage: string): ExecutionOutcome {
  return { status: "failed", retryable: false, errorClass, errorMessage };
}

/**
 * Sends one notice about `emails` (plus `more` not listed) to everyone the
 * channel reaches — one message per language, recipients in Bcc when there
 * are several, so they don't see each other's addresses.
 */
export async function sendNotice(
  channel: { id: string; tenantId: string; destinationId: string; config: EmailNotifyChannelConfig },
  emails: NotifyEmailInfo[],
  more: number,
  send: ForwardSender,
  messageIdSeed: string,
): Promise<ExecutionOutcome> {
  const { recipients, skipped } = await resolveNotifyRecipients(channel.tenantId, channel.config);
  if (recipients.length === 0) {
    return permanent("no_deliverable_recipients", skipped.length > 0 ? `Nobody on this channel can be notified: ${skipped.map((s) => `${s.address} (${s.reason})`).join(", ")}` : "Nobody on this channel can be notified (no active members match)");
  }
  const limitReached = await checkDailyLimit(channel.tenantId);
  if (limitReached) return permanent("rate_limited", limitReached);

  let sender;
  try {
    sender = await getSenderIdentity();
  } catch (error) {
    if (error instanceof MailerNotConfiguredError) return permanent("invalid_config", "SMTP is not configured (Settings › Outbound email) — no notice can be sent");
    throw error;
  }
  const [tenant, destination, settings] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { id: channel.tenantId }, select: { name: true, businessHours: true } }),
    prisma.destination.findUniqueOrThrow({ where: { id: channel.destinationId }, select: { name: true } }),
    getSystemSettings(),
  ]);

  const byLocale = new Map<Locale, string[]>();
  for (const r of recipients) byLocale.set(r.locale, [...(byLocale.get(r.locale) ?? []), r.address]);

  const messageIds: string[] = [];
  try {
    for (const [locale, addresses] of byLocale) {
      const notice = buildNotifyEmail({ locale, organizationName: tenant.name, destinationName: destination.name, config: channel.config, emails, more, appBaseUrl: settings.appBaseUrl, timeZone: businessHoursTimeZone(tenant.businessHours) });
      const info = await withTimeout(
        send(
          {
            from: { name: sender.name, address: sender.address },
            ...(addresses.length === 1 ? { to: addresses[0] } : { to: { name: sender.name, address: sender.address }, bcc: addresses }),
            subject: notice.subject,
            text: notice.text,
            html: notice.html,
            attachments: notice.inlineImages.map((image) => ({ ...image, contentDisposition: "inline" as const })),
            messageId: `<notify-${createHash("sha256").update(`${messageIdSeed}:${locale}`).digest("hex").slice(0, 32)}@eumaeus>`,
            headers: { "Auto-Submitted": "auto-generated", [FORWARDED_HEADER]: `notify:${channel.id}` },
          },
          { kind: "rule_notify", tenantId: channel.tenantId, relatedId: emails.length === 1 && more === 0 ? emails[0]!.id : channel.id },
        ),
        FORWARD_EXECUTOR_TIMEOUT_MS,
      );
      if (info.messageId) messageIds.push(info.messageId);
    }
  } catch (error) {
    if (error instanceof SendTimeoutError) return { status: "ambiguous", errorMessage: error.message };
    const failure = classifySmtpError(error);
    if (failure.kind === "maybe_sent") return { status: "ambiguous", errorMessage: `SMTP send did not complete: ${failure.message}` };
    return { status: "failed", retryable: failure.kind === "not_sent_retryable", errorClass: failure.errorClass, errorMessage: failure.message };
  }

  const now = new Date();
  await prisma.notifyChannelState.upsert({ where: { destinationChannelId: channel.id }, create: { destinationChannelId: channel.id, tenantId: channel.tenantId, lastSentAt: now }, update: { lastSentAt: now } });
  return { status: "succeeded", responseMetadata: { sent: true, notified: recipients.length, emails: emails.length + more, skipped, messageIds } };
}

async function queue(ctx: ExecutionContext, emailId: string, delivery: string): Promise<ExecutionOutcome> {
  await prisma.notifyQueueItem.upsert({
    where: { destinationChannelId_emailId: { destinationChannelId: ctx.channel.id, emailId } },
    create: { tenantId: ctx.tenantId, destinationChannelId: ctx.channel.id, emailId },
    update: {},
  });
  return { status: "succeeded", responseMetadata: { queued: true, delivery } };
}

async function executeNotify(ctx: ExecutionContext, send: ForwardSender): Promise<ExecutionOutcome> {
  const config = ctx.channel.config as EmailNotifyChannelConfig;
  const email = await prisma.email.findUnique({ where: { id: ctx.email.id }, select: { id: true, forwardedByEumaeus: true } });
  if (!email) return permanent("invalid_config", `Email ${ctx.email.id} no longer exists`);
  if (email.forwardedByEumaeus) return permanent("loop_detected", "This email is itself a copy Eumaeus sent; a notice about it could loop");

  const delivery = config.delivery ?? "each";
  if (delivery === "digest") return queue(ctx, email.id, delivery);
  if (delivery === "throttle") {
    const state = await prisma.notifyChannelState.findUnique({ where: { destinationChannelId: ctx.channel.id } });
    const window = (config.throttleMinutes ?? DEFAULT_NOTIFY_THROTTLE_MINUTES) * 60_000;
    if (state && Date.now() - state.lastSentAt.getTime() < window) return queue(ctx, email.id, delivery);
  }
  const [info] = await loadEmailInfo([email.id]);
  if (!info) return permanent("invalid_config", `Email ${ctx.email.id} no longer exists`);
  return sendNotice({ id: ctx.channel.id, tenantId: ctx.tenantId, destinationId: ctx.channel.destinationId, config }, [info], 0, send, ctx.idempotencyKey);
}

export function createEmailNotifyExecutor(sender: ForwardSender = sendMailMessage): DestinationExecutor {
  return { channelType: "email_notify", execute: (ctx) => executeNotify(ctx, sender) };
}

export const emailNotifyExecutor: DestinationExecutor = createEmailNotifyExecutor();

/**
 * The tick (with the forward digests): sends what throttled and digest
 * channels have queued once they are due. A queue entry is removed only
 * after its notice went out; a disabled channel's queue is dropped.
 */
export async function runNotifyFlush(now: Date = new Date(), send: ForwardSender = sendMailMessage): Promise<Array<{ channelId: string; emails: number; outcome: string }>> {
  const groups = await prisma.notifyQueueItem.groupBy({ by: ["destinationChannelId"], _min: { queuedAt: true } });
  const results: Array<{ channelId: string; emails: number; outcome: string }> = [];
  for (const group of groups) {
    const channel = await prisma.destinationChannel.findUnique({ where: { id: group.destinationChannelId }, include: { notifyState: true } });
    if (!channel || !channel.enabled || channel.type !== "email_notify") {
      await prisma.notifyQueueItem.deleteMany({ where: { destinationChannelId: group.destinationChannelId } });
      results.push({ channelId: group.destinationChannelId, emails: 0, outcome: "dropped" });
      continue;
    }
    const config = channel.config as EmailNotifyChannelConfig;
    const intervalMs = (config.delivery === "throttle" ? (config.throttleMinutes ?? DEFAULT_NOTIFY_THROTTLE_MINUTES) : (config.digestIntervalMinutes ?? DEFAULT_DIGEST_INTERVAL_MINUTES)) * 60_000;
    // Due when the window since the last notice has passed; a channel that never sent counts from its oldest queued email.
    const since = channel.notifyState?.lastSentAt ?? group._min.queuedAt ?? now;
    if (now.getTime() - since.getTime() < intervalMs) continue;

    const items = await prisma.notifyQueueItem.findMany({ where: { destinationChannelId: channel.id }, orderBy: { queuedAt: "asc" }, select: { id: true, emailId: true } });
    const emails = await loadEmailInfo(items.slice(0, MAX_NOTICE_LISTED).map((i) => i.emailId));
    const outcome = await sendNotice({ id: channel.id, tenantId: channel.tenantId, destinationId: channel.destinationId, config }, emails, Math.max(0, items.length - emails.length), send, `${channel.id}:${items.map((i) => i.id).join(",")}`);
    if (outcome.status !== "failed" || !outcome.retryable) {
      // Sent, sent-maybe (ambiguous: resending could duplicate) or can't ever be sent — either way these are done.
      await prisma.notifyQueueItem.deleteMany({ where: { id: { in: items.map((i) => i.id) } } });
    }
    if (outcome.status !== "succeeded") logger.warn({ event: "notify_flush_not_sent", channelId: channel.id, outcome }, "a queued rule notification could not be sent");
    results.push({ channelId: channel.id, emails: items.length, outcome: outcome.status });
  }
  return results;
}

/**
 * For the channel editor: the notice this config would produce for one of
 * the organization's emails (the given one, else the latest analyzed one,
 * else a made-up example). With `sendTo` it is also mailed — to that one
 * address (the person trying it out), nobody else, whatever the config says.
 */
export async function previewNotice(
  tenantId: string,
  input: { config: EmailNotifyChannelConfig; destinationName: string; emailId?: string; sendTo?: string },
): Promise<{ emailId: string | null; subject: string; html: string; text: string; sent?: boolean; error?: string }> {
  const emailId = input.emailId
    ? (await prisma.email.findFirst({ where: { id: input.emailId, tenantId }, select: { id: true } }))?.id
    : (await prisma.analysisResult.findFirst({ where: { tenantId, status: "ok" }, orderBy: { createdAt: "desc" }, select: { emailId: true } }))?.emailId;
  const [info] = emailId ? await loadEmailInfo([emailId]) : [];
  const [tenant, settings] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, locale: true, businessHours: true } }),
    getSystemSettings(),
  ]);
  const sample: NotifyEmailInfo = info ?? {
    id: "00000000-0000-0000-0000-000000000000",
    subject: "Example: order #1042 has not arrived",
    fromAddress: "customer@example.com",
    senderName: "A customer",
    mailbox: "support@example.com",
    receivedAt: new Date(),
  };
  const notice = buildNotifyEmail({
    locale: toLocale(tenant.locale),
    organizationName: tenant.name,
    destinationName: input.destinationName,
    config: input.config,
    emails: [sample],
    appBaseUrl: settings.appBaseUrl,
    timeZone: businessHoursTimeZone(tenant.businessHours),
    test: Boolean(input.sendTo),
  });
  // The editor shows it in a sandboxed frame, where cid: can't resolve.
  const logo = notice.inlineImages[0];
  const html = logo ? notice.html.replace(`cid:${logo.cid}`, `data:${logo.contentType};base64,${logo.content.toString("base64")}`) : notice.html;
  const result = { emailId: info?.id ?? null, subject: notice.subject, html, text: notice.text };
  if (!input.sendTo) return result;
  try {
    const sender = await getSenderIdentity();
    await sendMailMessage(
      {
        from: { name: sender.name, address: sender.address },
        to: input.sendTo,
        subject: notice.subject,
        text: notice.text,
        html: notice.html,
        attachments: notice.inlineImages.map((image) => ({ ...image, contentDisposition: "inline" as const })),
        headers: { "Auto-Submitted": "auto-generated", [FORWARDED_HEADER]: "notify:test" },
      },
      { kind: "rule_notify", tenantId, relatedId: info?.id ?? null },
    );
    return { ...result, sent: true };
  } catch (error) {
    return { ...result, sent: false, error: error instanceof Error ? error.message : String(error) };
  }
}
