import { simpleParser } from "mailparser";
import type Mail from "nodemailer/lib/mailer/index.js";
import { FORWARDED_HEADER } from "../../email/forwardHeaders.js";
import { DEFAULT_FORWARD_SUBJECT_TEMPLATE, type ForwardChannelConfig } from "../types.js";
import { emailText } from "../../i18n/emailText.js";
import type { Locale } from "../../i18n/locales.js";

/**
 * Composes the outgoing message for a "forward" channel. No I/O besides
 * parsing the stored source, so every mode can be tested without SMTP.
 * Everything taken from the original email is untrusted content: it's copied
 * into the forwarded message as data (escaped where it lands in our own HTML),
 * never interpreted.
 */
export interface ForwardComposeInput {
  config: ForwardChannelConfig;
  sender: { address: string; name: string };
  recipients: { to: string[]; cc: string[]; bcc: string[] };
  email: {
    id: string;
    fromAddress: string;
    toAddresses: string[];
    ccAddresses: string[];
    subject: string | null;
    receivedAt: Date;
    textBody: string | null;
    htmlBody: string | null;
    hasAttachments: boolean;
  };
  /** The stored original MIME source, or null when it's no longer kept. */
  source: Buffer | null;
  destinationName: string;
  analysis?: Record<string, unknown>;
  /** Deterministic per logical execution, so a retried send is recognizably the same message. */
  messageId: string;
  /** Phase 21: language of Eumaeus's own note (the organization's). The original stays as it was. */
  locale?: Locale;
}

export interface ComposedForward {
  message: Mail.Options;
  /** false when the original source wasn't available and the message was rebuilt from stored bodies (no attachments). */
  usedOriginalSource: boolean;
}

export class ForwardSourceUnavailableError extends Error {}

export async function composeForward(input: ForwardComposeInput): Promise<ComposedForward> {
  if (input.config.mode === "redirect") return composeRedirect(input);

  const locale = input.locale ?? "en";
  const tx = (key: Parameters<typeof emailText>[1], vars?: Record<string, string | number>) => emailText(locale, key, vars);
  const includeAnalysis = input.config.includeAnalysis !== false;
  const analysisLines = includeAnalysis && input.analysis ? describeAnalysis(input.analysis, locale) : [];
  const subject = renderSubject(input.config.subjectTemplate ?? DEFAULT_FORWARD_SUBJECT_TEMPLATE, input);
  const common: Mail.Options = {
    from: { name: input.config.fromName ?? input.sender.name, address: input.sender.address },
    // A guardrail may have dropped every "to" address while cc/bcc remain; nodemailer then sends to those alone.
    to: input.recipients.to.length > 0 ? input.recipients.to : undefined,
    cc: input.recipients.cc.length > 0 ? input.recipients.cc : undefined,
    bcc: input.recipients.bcc.length > 0 ? input.recipients.bcc : undefined,
    replyTo: input.config.replyTo === "none" ? undefined : input.email.fromAddress,
    subject,
    messageId: input.messageId,
    headers: { [FORWARDED_HEADER]: input.email.id, "Auto-Submitted": "auto-forwarded" },
  };

  const headerLines = [
    `${tx("hdrFrom")}: ${input.email.fromAddress}`,
    `${tx("hdrDate")}: ${input.email.receivedAt.toUTCString()}`,
    `${tx("hdrSubject")}: ${input.email.subject ?? ""}`,
    `${tx("hdrTo")}: ${input.email.toAddresses.join(", ")}`,
    ...(input.email.ccAddresses.length > 0 ? [`${tx("hdrCc")}: ${input.email.ccAddresses.join(", ")}`] : []),
  ];
  const intro = tx("fwdIntro", { destination: input.destinationName });

  if (input.config.mode === "attachment") {
    const notes: string[] = [];
    if (!input.source) notes.push(tx("fwdNoSourceAttached"));
    const text = [intro, "", ...headerLines, ...(analysisLines.length > 0 ? ["", ...analysisLines] : []), ...notes.flatMap((n) => ["", n]), ...(input.source ? [] : ["", input.email.textBody ?? ""])].join("\n");
    const html = coverHtml(intro, headerLines, analysisLines, notes) + (input.source ? "" : quotedHtml(input.email.htmlBody, input.email.textBody));
    return {
      message: {
        ...common,
        text,
        html,
        attachments: input.source ? [{ filename: "original-message.eml", content: input.source, contentType: "message/rfc822" }] : undefined,
      },
      usedOriginalSource: input.source !== null,
    };
  }

  // inline
  let bodyText = input.email.textBody ?? "";
  let bodyHtml = input.email.htmlBody;
  let attachments: Mail.Attachment[] | undefined;
  const notes: string[] = [];
  if (input.source) {
    const parsed = await simpleParser(input.source, { skipHtmlToText: true });
    bodyText = parsed.text ?? bodyText;
    bodyHtml = typeof parsed.html === "string" ? parsed.html : bodyHtml;
    if (input.config.includeAttachments !== false && parsed.attachments.length > 0) {
      attachments = parsed.attachments.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
        cid: a.cid,
      }));
    }
  } else if (input.email.hasAttachments && input.config.includeAttachments !== false) {
    notes.push(tx("fwdNoSourceAttachments"));
  }

  const separator = tx("fwdSeparator");
  const text = [intro, ...(analysisLines.length > 0 ? ["", ...analysisLines] : []), ...notes.flatMap((n) => ["", n]), "", separator, ...headerLines, "", bodyText].join("\n");
  const html = coverHtml(intro, [], analysisLines, notes) + `<p>${escapeHtml(separator)}<br>${headerLines.map(escapeHtml).join("<br>")}</p>` + quotedHtml(bodyHtml, bodyText);
  return { message: { ...common, text, html, attachments }, usedOriginalSource: input.source !== null };
}

/**
 * The original bytes, untouched, with Resent-* headers prepended (RFC 5322
 * §3.6.6). The envelope carries the real recipients — Bcc never appears in a
 * header. Keeps the original From, which is exactly why receiving servers may
 * reject it (DMARC); the UI says so before this mode is chosen.
 */
function composeRedirect(input: ForwardComposeInput): ComposedForward {
  if (!input.source) {
    throw new ForwardSourceUnavailableError("Redirect needs the original message, which is no longer stored (see Settings › Keep original messages)");
  }
  const resent = [
    `Resent-From: ${input.sender.address}`,
    ...(input.recipients.to.length > 0 ? [`Resent-To: ${input.recipients.to.join(", ")}`] : []),
    ...(input.recipients.cc.length > 0 ? [`Resent-Cc: ${input.recipients.cc.join(", ")}`] : []),
    `Resent-Date: ${new Date().toUTCString()}`,
    `Resent-Message-ID: ${input.messageId}`,
    `${FORWARDED_HEADER}: ${input.email.id}`,
    "Auto-Submitted: auto-forwarded",
  ].join("\r\n");
  return {
    message: {
      envelope: { from: input.sender.address, to: [...input.recipients.to, ...input.recipients.cc, ...input.recipients.bcc] },
      raw: Buffer.concat([Buffer.from(`${resent}\r\n`), input.source]),
    },
    usedOriginalSource: true,
  };
}

export function renderSubject(template: string, input: Pick<ForwardComposeInput, "email" | "destinationName" | "analysis">): string {
  const values: Record<string, string> = {
    subject: input.email.subject ?? "(no subject)",
    sender: input.email.fromAddress,
    category: categoryOf(input.analysis) ?? "unknown",
    destination: input.destinationName,
  };
  const rendered = template.replace(/\{(subject|sender|category|destination)\}/g, (_, key: string) => values[key] ?? "");
  // The original subject is attacker-controlled; a header must stay one line.
  return rendered.replace(/[\r\n]+/g, " ").slice(0, 250);
}

/** Reads Decision Schema answers by shape only (this module must not import modules/jev). Unknown or malformed answers are skipped, never guessed. */
export function describeAnalysis(signals: Record<string, unknown>, locale: Locale = "en"): string[] {
  const parts: string[] = [];
  const spam = (signals.is_spam as { noul?: unknown } | undefined)?.noul;
  if (typeof spam === "number") parts.push(emailText(locale, "analysisSpam", { score: spam.toFixed(2) }));
  const category = categoryOf(signals);
  if (category) parts.push(emailText(locale, "analysisCategory", { category }));
  const urgency = signals.urgency as { score?: unknown; legend?: Record<string, unknown> } | undefined;
  if (urgency && typeof urgency.score === "number") {
    const label = urgency.legend?.[String(urgency.score)];
    parts.push(emailText(locale, "analysisUrgency", { urgency: typeof label === "string" ? label : urgency.score }));
  }
  return parts.length > 0 ? [emailText(locale, "analysisLine", { parts: parts.join(", ") })] : [];
}

function categoryOf(signals: Record<string, unknown> | undefined): string | undefined {
  const choice = (signals?.category as { choice?: unknown } | undefined)?.choice;
  return typeof choice === "string" ? choice : undefined;
}

function coverHtml(intro: string, headerLines: string[], analysisLines: string[], notes: string[]): string {
  const block = (lines: string[]) => (lines.length > 0 ? `<p>${lines.map(escapeHtml).join("<br>")}</p>` : "");
  return `<p>${escapeHtml(intro)}</p>${block(headerLines)}${block(analysisLines)}${notes.map((n) => `<p><em>${escapeHtml(n)}</em></p>`).join("")}`;
}

function quotedHtml(html: string | null, text: string | null): string {
  const inner = html ?? `<pre style="white-space:pre-wrap">${escapeHtml(text ?? "")}</pre>`;
  return `<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${inner}</blockquote>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
