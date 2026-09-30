import type { Locale } from "../i18n/locales.js";
import { emailText } from "../i18n/emailText.js";
import type { InlineImage } from "./mailer.js";
import { actions, badge, heading, LOGO_IMAGES, note, paragraph, renderEmail, spacer } from "./emailLayout.js";

/** The invite email's content — a small, self-contained template. `acceptUrl` already has the raw token embedded; this only formats. Phase 21: in the invitee's language. 1.0.2: in the shared email frame. */
export function buildInviteEmail(organizationName: string, acceptUrl: string, locale: Locale = "en"): { subject: string; html: string; text: string; inlineImages: InlineImage[] } {
  const tx = (key: Parameters<typeof emailText>[1]) => emailText(locale, key, { org: organizationName });
  const subject = tx("inviteSubject");
  return {
    subject,
    text: `${tx("inviteBody")}\n\n${tx("inviteAccept")}: ${acceptUrl}\n\n${tx("ignoreIfUnexpected")}`,
    html: renderEmail({
      locale,
      subject,
      preheader: tx("inviteBody"),
      tone: "accent",
      body: [badge(tx("inviteBadge"), "accent"), spacer(16), heading(organizationName), paragraph(tx("inviteBody")), actions({ href: acceptUrl, label: tx("inviteAccept") }), note(tx("ignoreIfUnexpected"))].join("\n"),
    }),
    inlineImages: LOGO_IMAGES,
  };
}
