import type { Locale } from "../i18n/locales.js";
import { emailText } from "../i18n/emailText.js";
import type { InlineImage } from "./mailer.js";
import { actions, badge, heading, LOGO_IMAGES, note, paragraph, renderEmail, spacer } from "./emailLayout.js";

/** Sent to a new forward recipient. Nothing is forwarded to the address until its owner follows the link. Phase 21: in the organization's language. 1.0.2: in the shared email frame. */
export function buildForwardVerificationEmail(
  organizationName: string,
  confirmUrl: string,
  expiresInDays: number,
  locale: Locale = "en",
): { subject: string; html: string; text: string; inlineImages: InlineImage[] } {
  const tx = (key: Parameters<typeof emailText>[1]) => emailText(locale, key, { org: organizationName, days: expiresInDays });
  const subject = tx("fwdVerifySubject");
  return {
    subject,
    text: [tx("fwdVerifyBody"), "", `${tx("fwdVerifyConfirm")}: ${confirmUrl}`, "", tx("fwdVerifyNote"), tx("ignoreIfUnexpected")].join("\n"),
    html: renderEmail({
      locale,
      subject,
      preheader: tx("fwdVerifyBody"),
      tone: "accent",
      body: [
        badge(tx("fwdVerifyBadge"), "accent"),
        spacer(16),
        heading(organizationName),
        paragraph(tx("fwdVerifyBody")),
        actions({ href: confirmUrl, label: tx("fwdVerifyConfirm") }),
        note(`${tx("fwdVerifyNote")} ${tx("ignoreIfUnexpected")}`),
      ].join("\n"),
    }),
    inlineImages: LOGO_IMAGES,
  };
}
