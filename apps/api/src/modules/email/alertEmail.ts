import type { Locale } from "../i18n/locales.js";
import { alertHint, emailText } from "../i18n/emailText.js";
import type { InlineImage } from "./mailer.js";
import { actions, badge, callout, facts as factsTable, heading, lead as leadLine, LOGO_IMAGES, quoteBox, renderEmail, formatEmailDuration, formatEmailTime, type Tone } from "./emailLayout.js";

export interface AlertEmailInput {
  organizationName: string;
  title: string;
  detail: string;
  resolved: boolean;
  /** The web app's home (the dashboard shows open alerts). */
  link: string;
  locale?: Locale;
  /** 1.0.2: the alert's kind picks the advice and the page the button opens. */
  kind?: string;
  /** A daily reminder for an alert that is still open. */
  reminder?: boolean;
  firstSeenAt?: Date;
  resolvedAt?: Date | null;
  /** Times are shown in this zone (the organization's business-hours zone), else UTC. */
  timeZone?: string;
  /** The organization's page, where alert emails are turned off. */
  settingsLink?: string;
}

/** Where the button goes for each kind of alert — the page where it gets fixed. */
const KIND_PATH: Record<string, string> = {
  mailbox_reauth_required: "mailboxes",
  mailbox_sync_failing: "mailboxes",
  action_failures: "emails",
  jev_errors: "emails",
  jev_access_denied: "emails",
  forward_failures: "destinations",
};

/** Clay marks an open alert, mustard a reminder, green a resolved one — the badge also says it in words. */
const TONE_BY_STATE: Record<"open" | "reminder" | "resolved", Tone> = { open: "accent", reminder: "warning", resolved: "success" };

/**
 * Phase 18: one email when an alert opens (or is still open a day later), one
 * when it resolves. Phase 21: the frame is in the recipient's language; the
 * alert's own title and detail are stored text and stay as written.
 * 1.0.2: a designed HTML message — logo, status badge, the detail in a box,
 * when it started (and how long it lasted), what to do about it, and a
 * button to the page where it gets fixed. Table layout and inline styles
 * only, so it holds together in Gmail, Outlook and Apple Mail; the plain-text
 * part carries the same content.
 */
export function buildAlertEmail(input: AlertEmailInput): { subject: string; text: string; html: string; inlineImages: InlineImage[] } {
  const locale = input.locale ?? "en";
  const state = input.resolved ? "resolved" : input.reminder ? "reminder" : "open";
  const tone = TONE_BY_STATE[state];
  const prefix = input.resolved ? emailText(locale, "alertResolvedPrefix") : input.reminder ? emailText(locale, "alertReminderPrefix") : "";
  const subject = emailText(locale, "alertSubject", { prefix, title: input.title, org: input.organizationName }).replace(/[\r\n]+/g, " ");
  const lead = emailText(locale, input.resolved ? "alertLeadResolved" : input.reminder ? "alertLeadReminder" : "alertLeadOpen");
  const badgeText = emailText(locale, input.resolved ? "alertBadgeResolved" : input.reminder ? "alertBadgeReminder" : "alertBadgeOpen");
  const hint = input.resolved || !input.kind ? null : alertHint(locale, input.kind);
  const base = input.link.replace(/\/$/, "");
  const target = input.kind && KIND_PATH[input.kind] && !input.resolved ? `${base}/${KIND_PATH[input.kind]}` : `${base}/`;
  const timeZone = input.timeZone || "UTC";

  const facts: [string, string][] = [[emailText(locale, "alertOrgLabel"), input.organizationName]];
  if (input.firstSeenAt) facts.push([emailText(locale, "alertFirstSeenLabel"), formatEmailTime(input.firstSeenAt, locale, timeZone)]);
  if (input.resolved && input.resolvedAt) {
    facts.push([emailText(locale, "alertResolvedAtLabel"), formatEmailTime(input.resolvedAt, locale, timeZone)]);
    if (input.firstSeenAt) facts.push([emailText(locale, "alertDurationLabel"), formatEmailDuration(input.resolvedAt.getTime() - input.firstSeenAt.getTime(), locale)]);
  }

  const text = [
    lead,
    "",
    input.title,
    ...(input.resolved ? [] : ["", input.detail]),
    "",
    ...facts.map(([label, value]) => `${label}: ${value}`),
    ...(hint ? ["", `${emailText(locale, "alertWhatToDo")} ${hint}`] : []),
    "",
    emailText(locale, "alertDetails", { url: target }),
    "",
    "—",
    emailText(locale, "alertFooter", { org: input.organizationName }),
  ].join("\n");

  const html = renderEmail({
    locale,
    subject,
    preheader: `${input.title} · ${input.organizationName}`,
    tone,
    body: [
      badge(badgeText, tone),
      leadLine(lead),
      heading(input.title),
      input.resolved ? "" : quoteBox(input.detail, tone),
      factsTable(facts),
      hint ? callout(emailText(locale, "alertWhatToDo"), hint) : "",
      actions({ href: target, label: emailText(locale, "alertCta") }, input.settingsLink ? { href: input.settingsLink, label: emailText(locale, "alertSettingsLink") } : undefined),
    ].join("\n"),
    footer: emailText(locale, "alertFooter", { org: input.organizationName }),
  });

  return { subject, text, html, inlineImages: LOGO_IMAGES };
}
