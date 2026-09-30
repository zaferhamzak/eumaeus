import type Mail from "nodemailer/lib/mailer/index.js";
import { FORWARDED_HEADER } from "../../email/forwardHeaders.js";
import type { ForwardChannelConfig } from "../types.js";
import { describeAnalysis } from "./forwardMessage.js";
import { emailText } from "../../i18n/emailText.js";
import type { Locale } from "../../i18n/locales.js";

/**
 * Composes one digest message for a batch of queued emails (Phase 13.4). Like
 * forwardMessage.ts: no I/O, every value taken from an original email is
 * untrusted and escaped where it lands in HTML.
 *
 *   mode "attachment" — each original attached as .eml, up to
 *                       MAX_DIGEST_ATTACHMENT_BYTES in total; the rest are
 *                       listed with a note.
 *   mode "inline"     — a short text excerpt of each email, no attachments.
 */
export const MAX_DIGEST_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const EXCERPT_CHARS = 500;

export interface DigestEmail {
  id: string;
  fromAddress: string;
  subject: string | null;
  receivedAt: Date;
  textBody: string | null;
  source: Buffer | null;
  analysis?: Record<string, unknown>;
}

export interface DigestComposeInput {
  config: ForwardChannelConfig;
  sender: { address: string; name: string };
  recipients: { to: string[]; cc: string[]; bcc: string[] };
  destinationName: string;
  emails: DigestEmail[];
  batchId: string;
  /** Phase 21: the organization's language. */
  locale?: Locale;
}

export interface ComposedDigest {
  message: Mail.Options;
  attached: number;
  notAttached: number;
}

export function composeDigest(input: DigestComposeInput): ComposedDigest {
  const count = input.emails.length;
  const locale = input.locale ?? "en";
  const includeAnalysis = input.config.includeAnalysis !== false;
  const attachOriginals = input.config.mode === "attachment";

  const attachments: Mail.Attachment[] = [];
  let attachedBytes = 0;
  let notAttached = 0;
  const textParts: string[] = [];
  const htmlParts: string[] = [];

  input.emails.forEach((email, index) => {
    const n = index + 1;
    const subject = (email.subject ?? emailText(locale, "noSubject")).replace(/[\r\n]+/g, " ");
    const lines = [`${n}. ${subject}`, `   ${emailText(locale, "hdrFrom")}: ${email.fromAddress}`, `   ${emailText(locale, "hdrDate")}: ${email.receivedAt.toUTCString()}`];
    if (includeAnalysis && email.analysis) lines.push(...describeAnalysis(email.analysis, locale).map((l) => `   ${l}`));

    let note: string | undefined;
    if (attachOriginals) {
      if (email.source && attachedBytes + email.source.length <= MAX_DIGEST_ATTACHMENT_BYTES) {
        attachments.push({ filename: `${String(n).padStart(2, "0")}-${safeFilename(subject)}.eml`, content: email.source, contentType: "message/rfc822" });
        attachedBytes += email.source.length;
      } else {
        notAttached += 1;
        note = emailText(locale, email.source ? "fwdDigestSizeLimit" : "fwdDigestNoSource");
      }
    }
    const excerpt = !attachOriginals && email.textBody ? excerptOf(email.textBody) : undefined;

    textParts.push([...lines, ...(note ? [`   ${note}`] : []), ...(excerpt ? ["", indent(excerpt)] : [])].join("\n"));
    htmlParts.push(
      `<li style="margin-bottom:12px"><strong>${escapeHtml(subject)}</strong><br>` +
        `${emailText(locale, "hdrFrom")}: ${escapeHtml(email.fromAddress)}<br>${emailText(locale, "hdrDate")}: ${escapeHtml(email.receivedAt.toUTCString())}` +
        (includeAnalysis && email.analysis ? describeAnalysis(email.analysis, locale).map((l) => `<br>${escapeHtml(l)}`).join("") : "") +
        (note ? `<br><em>${escapeHtml(note)}</em>` : "") +
        (excerpt ? `<blockquote style="margin:6px 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex;white-space:pre-wrap">${escapeHtml(excerpt)}</blockquote>` : "") +
        "</li>",
    );
  });

  const title = emailText(locale, "fwdDigestTitle", { count, destination: input.destinationName });
  const intro = emailText(locale, "fwdDigestIntro", { destination: input.destinationName });
  return {
    message: {
      from: { name: input.config.fromName ?? input.sender.name, address: input.sender.address },
      to: input.recipients.to.length > 0 ? input.recipients.to : undefined,
      cc: input.recipients.cc.length > 0 ? input.recipients.cc : undefined,
      bcc: input.recipients.bcc.length > 0 ? input.recipients.bcc : undefined,
      subject: title.replace(/[\r\n]+/g, " ").slice(0, 250),
      messageId: `<digest-${input.batchId}@eumaeus>`,
      headers: { [FORWARDED_HEADER]: `digest:${input.batchId}`, "Auto-Submitted": "auto-forwarded" },
      text: [intro, "", ...textParts.flatMap((p) => [p, ""])].join("\n"),
      html: `<p>${escapeHtml(intro)}</p><ol style="padding-left:20px">${htmlParts.join("")}</ol>`,
      attachments: attachments.length > 0 ? attachments : undefined,
    },
    attached: attachments.length,
    notAttached,
  };
}

function excerptOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > EXCERPT_CHARS ? `${trimmed.slice(0, EXCERPT_CHARS)}…` : trimmed;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `   > ${l}`)
    .join("\n");
}

function safeFilename(subject: string): string {
  return subject.replace(/[^\p{L}\p{N} _-]+/gu, "").trim().slice(0, 60).replace(/\s+/g, "-") || "email";
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
