import nodemailer from "nodemailer";
import type Mail from "nodemailer/lib/mailer/index.js";
import { getSystemSettings, resolveSmtpPassword } from "../settings/systemSettings.js";
import { badge, heading, LOGO_IMAGES, paragraph, renderEmail, spacer } from "./emailLayout.js";
import { recordOutbound, type OutboundMeta } from "./outboundLog.js";

/**
 * Outbound SMTP — the counterpart to modules/mail-providers/imap (which is
 * strictly INCOMING). Nothing in this codebase sent an email before Phase
 * 11.1; this is the one place that changes. Entirely optional: every caller
 * checks isMailerConfigured() first and treats "not configured" as a normal,
 * expected state (the feature that needed to send — invite emails — still
 * fully works without it, via the manually-shared link), never an error.
 *
 * Phase 11.2: reads from the UI-editable SystemSettings row (getSystemSettings())
 * instead of env vars directly, so a superAdmin changing SMTP settings on the
 * Settings page takes effect on the very next send — no server restart. A
 * fresh Transporter is built PER SEND (not cached as a module-level
 * singleton like the earlier version) for exactly this reason: caching one
 * would keep using stale credentials/host until the process restarted.
 * nodemailer's own transport construction is cheap — it doesn't actually
 * open a connection until sendMail() is called.
 */
export async function isMailerConfigured(): Promise<boolean> {
  const settings = await getSystemSettings();
  return Boolean(settings.smtpHost);
}

/** An image the HTML part shows with <img src="cid:…"> (sent as an inline attachment). */
export interface InlineImage {
  cid: string;
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  inlineImages?: InlineImage[];
  /** 1.2 (F): what this email is, for the delivery log. Required so no send goes unlogged. */
  meta: OutboundMeta;
}

export class MailerNotConfiguredError extends Error {}

/** Throws MailerNotConfiguredError if SMTP isn't configured — callers that treat email as best-effort should check isMailerConfigured() first rather than relying on this throw for control flow. */
export async function sendEmail(input: SendEmailInput): Promise<void> {
  const sender = await getSenderIdentity();
  await sendMailMessage(
    {
      from: `"${sender.name}" <${sender.address}>`,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      ...(input.inlineImages?.length ? { attachments: input.inlineImages.map((image) => ({ ...image, contentDisposition: "inline" as const })) } : {}),
    },
    input.meta,
  );
}

/** Settings › "Send test email". Throws whatever the SMTP transport threw, so the caller can explain it. */
export async function sendTestEmail(to: string): Promise<void> {
  const subject = "Eumaeus test email";
  const text = "This is a test email from Eumaeus. If you received it, outbound email is working.";
  await sendEmail({
    to,
    subject,
    text,
    // 1.0.2: in the same frame as every other system email, so the test also shows how they look.
    html: renderEmail({ locale: "en", subject, preheader: text, tone: "success", body: [badge("Test", "success"), spacer(16), heading("Outbound email works"), paragraph(text)].join("\n") }),
    inlineImages: LOGO_IMAGES,
    meta: { kind: "smtp_test" },
  });
}

export interface SenderIdentity {
  address: string;
  name: string;
}

/** The configured From identity. Throws MailerNotConfiguredError when SMTP isn't set up or has no usable sender address. */
export async function getSenderIdentity(): Promise<SenderIdentity> {
  const settings = await getSystemSettings();
  const address = settings.smtpFromAddress ?? settings.smtpUsername;
  if (!settings.smtpHost || !address) throw new MailerNotConfiguredError("SMTP is not configured");
  return { address, name: settings.smtpFromName };
}

export interface SentMessageInfo {
  messageId?: string;
  accepted: string[];
  rejected: string[];
}

/**
 * Sends an already-composed nodemailer message (Phase 13: the forward
 * executor composes attachments, envelopes and raw redirects itself). Errors
 * are thrown as nodemailer raised them — callers that need to tell "never
 * sent" from "maybe sent" inspect the error's code/command.
 */
export async function sendMailMessage(message: Mail.Options, meta: OutboundMeta = { kind: "other" }): Promise<SentMessageInfo> {
  const settings = await getSystemSettings();
  if (!settings.smtpHost) throw new MailerNotConfiguredError("SMTP is not configured");

  const password = await resolveSmtpPassword();
  const transporter = nodemailer.createTransport({
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: settings.smtpSecure,
    auth: settings.smtpUsername && password ? { user: settings.smtpUsername, pass: password } : undefined,
  });

  const info = await transporter.sendMail(message).catch(async (error: unknown) => {
    await recordOutbound(message, meta, { error });
    throw error;
  });
  await recordOutbound(message, meta, { messageId: info.messageId });
  return {
    messageId: info.messageId,
    accepted: (info.accepted ?? []).map(String),
    rejected: (info.rejected ?? []).map(String),
  };
}
