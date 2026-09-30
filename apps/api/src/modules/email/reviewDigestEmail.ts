import type { Locale } from "../i18n/locales.js";
import { emailText, reviewReason } from "../i18n/emailText.js";
import type { InlineImage } from "./mailer.js";
import { actions, badge, heading, LOGO_IMAGES, mailItem, mailList, note, paragraph, renderEmail, spacer } from "./emailLayout.js";

export interface DigestItem {
  subject: string | null;
  fromAddress: string;
  reason: string;
  /** Phase 23: one-click decision links for this recipient (signed, 7 days). */
  actions?: { spamUrl: string; approveUrl: string };
}

/**
 * Subjects and senders come from real, untrusted inbound email — every one is HTML-escaped before it goes into the html body (emailLayout does it). Phase 21: in the recipient's language.
 * 1.0.2: in the shared email frame — each waiting email as a row with its sender and reason, and the one-click decisions as small buttons.
 */
export function buildReviewDigestEmail(
  organizationName: string,
  newCount: number,
  totalOpen: number,
  sample: DigestItem[],
  reviewUrl: string,
  locale: Locale = "en",
): { subject: string; html: string; text: string; inlineImages: InlineImage[] } {
  const line = (item: DigestItem) => `${item.subject || emailText(locale, "noSubject")} — ${item.fromAddress} (${reviewReason(locale, item.reason)})`;
  const more = newCount > sample.length ? newCount - sample.length : 0;
  const body = emailText(locale, "digestBody", { count: newCount, org: organizationName, total: totalOpen });
  const moreText = more > 0 ? emailText(locale, "digestMore", { count: more }) : "";
  const subject = emailText(locale, "digestSubject", { count: newCount, org: organizationName });
  const hasActions = sample.some((i) => i.actions);

  return {
    subject,
    text: [
      body,
      "",
      ...sample.flatMap((item) => [
        `• ${line(item)}`,
        ...(item.actions ? [`  ${emailText(locale, "digestActionSpam")}: ${item.actions.spamUrl}`, `  ${emailText(locale, "digestActionApprove")}: ${item.actions.approveUrl}`] : []),
      ]),
      ...(more > 0 ? [moreText] : []),
      "",
      emailText(locale, "digestReviewLink", { url: reviewUrl }),
      ...(hasActions ? ["", emailText(locale, "digestActionsNote")] : []),
      "",
      "—",
      emailText(locale, "digestFooter"),
    ].join("\n"),
    html: renderEmail({
      locale,
      subject,
      preheader: body,
      tone: "accent",
      body: [
        badge(emailText(locale, "digestBadge"), "accent"),
        spacer(16),
        heading(subject),
        paragraph(body),
        mailList(
          sample.map((item) =>
            mailItem({
              subject: item.subject || emailText(locale, "noSubject"),
              from: item.fromAddress,
              reason: reviewReason(locale, item.reason),
              links: item.actions
                ? [
                    { href: item.actions.spamUrl, label: emailText(locale, "digestActionSpam") },
                    { href: item.actions.approveUrl, label: emailText(locale, "digestActionApprove") },
                  ]
                : undefined,
            }),
          ),
        ),
        more > 0 ? paragraph(moreText) : "",
        actions({ href: reviewUrl, label: emailText(locale, "digestOpen") }),
        hasActions ? note(emailText(locale, "digestActionsNote")) : "",
      ].join("\n"),
      footer: emailText(locale, "digestFooter"),
    }),
    inlineImages: LOGO_IMAGES,
  };
}
