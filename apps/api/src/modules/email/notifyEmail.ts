import type { Locale } from "../i18n/locales.js";
import { emailText } from "../i18n/emailText.js";
import { describeAnalysis } from "../destinations/executors/forwardMessage.js";
import { DEFAULT_NOTIFY_SUBJECT_TEMPLATE, NOTIFY_EXCERPT_CHARS, type EmailNotifyChannelConfig } from "../destinations/types.js";
import type { InlineImage } from "./mailer.js";
import { actions, badge, facts, formatEmailTime, heading, lead, LOGO_IMAGES, mailItem, mailList, note, paragraph, quoteBox, renderEmail, spacer } from "./emailLayout.js";

/** One email a notice is about. Everything here comes from inbound mail — escaped on the way into HTML (emailLayout). */
export interface NotifyEmailInfo {
  id: string;
  subject: string | null;
  fromAddress: string;
  senderName: string | null;
  mailbox: string;
  receivedAt: Date;
  signals?: Record<string, unknown>;
  textBody?: string | null;
}

export const MAX_NOTICE_LISTED = 20;

/** Fills {placeholders}; unknown ones are left as typed so a mistake is visible. Line breaks never reach a subject. */
export function renderNotifyTemplate(template: string, email: NotifyEmailInfo, destination: string, locale: Locale, singleLine = false): string {
  const category = (email.signals?.category as { choice?: unknown } | undefined)?.choice;
  const urgency = email.signals?.urgency as { score?: unknown; legend?: Record<string, unknown> } | undefined;
  const urgencyLabel = urgency && typeof urgency.score === "number" ? (typeof urgency.legend?.[String(urgency.score)] === "string" ? String(urgency.legend[String(urgency.score)]) : String(urgency.score)) : "";
  const spam = (email.signals?.is_spam as { noul?: unknown } | undefined)?.noul;
  const values: Record<string, string> = {
    subject: email.subject || emailText(locale, "noSubject"),
    sender: email.fromAddress,
    sender_name: email.senderName || email.fromAddress,
    mailbox: email.mailbox,
    category: typeof category === "string" ? category : "",
    urgency: urgencyLabel,
    spam: typeof spam === "number" ? spam.toFixed(2) : "",
    destination,
  };
  const out = template.replace(/\{(subject|sender_name|sender|mailbox|category|urgency|spam|destination)\}/g, (_, k: string) => values[k] ?? "");
  return singleLine ? out.replace(/[\r\n]+/g, " ").slice(0, 250) : out;
}

/**
 * 1.2 (O): the notice a rule sends. One email: who wrote, about what, from
 * which mailbox, what Jev made of it, optionally the first lines, and a
 * button to it in Eumaeus. Several (throttle / digest): a list, each linked.
 */
export function buildNotifyEmail(input: {
  locale: Locale;
  organizationName: string;
  destinationName: string;
  config: EmailNotifyChannelConfig;
  emails: NotifyEmailInfo[];
  /** Emails beyond `emails` that are part of this notice but not listed. */
  more?: number;
  appBaseUrl: string;
  timeZone?: string;
  test?: boolean;
}): { subject: string; html: string; text: string; inlineImages: InlineImage[] } {
  const { locale, destinationName: destination, config } = input;
  const base = input.appBaseUrl.replace(/\/$/, "");
  const tz = input.timeZone || "UTC";
  const footer = emailText(locale, "notifyFooter", { org: input.organizationName, destination });
  const testNote = input.test ? note(emailText(locale, "notifyTestNote")) : "";
  const total = input.emails.length + (input.more ?? 0);

  if (total === 1 && input.emails[0]) {
    const email = input.emails[0];
    const subject = renderNotifyTemplate(config.subjectTemplate ?? DEFAULT_NOTIFY_SUBJECT_TEMPLATE, email, destination, locale, true);
    const intro = renderNotifyTemplate(config.intro ?? emailText(locale, "notifyIntroDefault", { destination: "{destination}" }), email, destination, locale);
    const jev = email.signals ? describeAnalysis(email.signals, locale)[0]?.replace(/^[^:]+:\s*/, "") : undefined;
    const rows: [string, string][] = [
      [emailText(locale, "notifyFrom"), email.senderName ? `${email.senderName} <${email.fromAddress}>` : email.fromAddress],
      [emailText(locale, "notifyMailbox"), email.mailbox],
      [emailText(locale, "notifyReceived"), formatEmailTime(email.receivedAt, locale, tz)],
      ...(jev ? ([[emailText(locale, "notifyJev"), jev]] as [string, string][]) : []),
    ];
    const excerpt = config.includeExcerpt && email.textBody ? email.textBody.replace(/\s+\n/g, "\n").trim().slice(0, NOTIFY_EXCERPT_CHARS) + (email.textBody.length > NOTIFY_EXCERPT_CHARS ? "…" : "") : "";
    const link = `${base}/emails/${email.id}`;
    return {
      subject,
      text: [intro, "", email.subject || emailText(locale, "noSubject"), "", ...rows.map(([l, v]) => `${l}: ${v}`), ...(excerpt ? ["", excerpt] : []), "", `${emailText(locale, "notifyOpen")}: ${link}`, "", "—", footer].join("\n"),
      html: renderEmail({
        locale,
        subject,
        preheader: `${email.senderName || email.fromAddress}: ${email.subject ?? ""}`,
        tone: "accent",
        body: [badge(emailText(locale, "notifyBadge"), "accent"), lead(intro), heading(email.subject || emailText(locale, "noSubject")), facts(rows), excerpt ? quoteBox(excerpt, "accent") : "", actions({ href: link, label: emailText(locale, "notifyOpen") }), testNote].join("\n"),
        footer,
      }),
      inlineImages: LOGO_IMAGES,
    };
  }

  const listed = input.emails.slice(0, MAX_NOTICE_LISTED);
  const more = total - listed.length;
  const subject = emailText(locale, "notifyDigestSubject", { count: total, destination }).replace(/[\r\n]+/g, " ");
  const intro = emailText(locale, "notifyDigestIntro", { count: total, destination });
  const moreText = more > 0 ? emailText(locale, "digestMore", { count: more }) : "";
  const reason = (e: NotifyEmailInfo) => `${e.mailbox} · ${formatEmailTime(e.receivedAt, locale, tz)}`;
  return {
    subject,
    text: [intro, "", ...listed.map((e) => `• ${e.subject || emailText(locale, "noSubject")} — ${e.fromAddress}\n  ${base}/emails/${e.id}`), ...(more > 0 ? [moreText] : []), "", `${emailText(locale, "notifyOpenAll")}: ${base}/emails`, "", "—", footer].join("\n"),
    html: renderEmail({
      locale,
      subject,
      preheader: intro,
      tone: "accent",
      body: [
        badge(emailText(locale, "notifyBadge"), "accent"),
        spacer(16),
        heading(subject),
        paragraph(intro),
        mailList(listed.map((e) => mailItem({ subject: e.subject || emailText(locale, "noSubject"), from: e.senderName ? `${e.senderName} <${e.fromAddress}>` : e.fromAddress, reason: reason(e), href: `${base}/emails/${e.id}` }))),
        more > 0 ? paragraph(moreText) : "",
        actions({ href: `${base}/emails`, label: emailText(locale, "notifyOpenAll") }),
        testNote,
      ].join("\n"),
      footer,
    }),
    inlineImages: LOGO_IMAGES,
  };
}
