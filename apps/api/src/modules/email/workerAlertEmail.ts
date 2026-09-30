import type { Locale } from "../i18n/locales.js";
import { emailText } from "../i18n/emailText.js";
import type { InlineImage } from "./mailer.js";
import { actions, badge, callout, facts, formatEmailDuration, formatEmailTime, heading, LOGO_IMAGES, paragraph, renderEmail, spacer } from "./emailLayout.js";

export type WorkerNotice =
  | { kind: "down"; noticedAt: Date; lastSeenAt: Date | null; minutesDown: number }
  | { kind: "recovered"; noticedAt: Date; recoveredAt: Date };

/**
 * 1.1 (A): to the system administrators when the background worker stops
 * (and when it is back). Sent by the API process — the worker can't report
 * its own death, and the operational alerts it evaluates stop with it.
 */
export function buildWorkerAlertEmail(notice: WorkerNotice, appBaseUrl: string, locale: Locale): { subject: string; html: string; text: string; inlineImages: InlineImage[] } {
  const down = notice.kind === "down";
  const tx = (key: Parameters<typeof emailText>[1], vars: Record<string, string | number> = {}) => emailText(locale, key, vars);
  const subject = tx(down ? "workerDownSubject" : "workerUpSubject");
  const body = down ? tx("workerDownBody", { minutes: notice.minutesDown }) : tx("workerUpBody");
  const rows: [string, string][] = down
    ? [
        ...(notice.lastSeenAt ? ([[tx("workerLastSeenLabel"), formatEmailTime(notice.lastSeenAt, locale, "UTC")]] as [string, string][]) : []),
        [tx("workerNoticedLabel"), formatEmailTime(notice.noticedAt, locale, "UTC")],
      ]
    : [
        [tx("workerNoticedLabel"), formatEmailTime(notice.noticedAt, locale, "UTC")],
        [tx("workerOutageLabel"), formatEmailDuration(notice.recoveredAt.getTime() - notice.noticedAt.getTime(), locale)],
      ];
  const systemUrl = `${appBaseUrl.replace(/\/$/, "")}/system`;
  const tone = down ? "accent" : "success";

  return {
    subject,
    text: [body, "", ...rows.map(([l, v]) => `${l}: ${v}`), ...(down ? ["", tx("workerDownHint")] : []), "", `${tx("workerCta")}: ${systemUrl}`, "", "—", tx("workerFooter")].join("\n"),
    html: renderEmail({
      locale,
      subject,
      preheader: body,
      tone,
      body: [
        badge(tx(down ? "workerBadgeDown" : "workerBadgeUp"), tone),
        spacer(16),
        heading(tx(down ? "workerDownHeading" : "workerUpHeading")),
        paragraph(body),
        facts(rows),
        down ? callout(emailText(locale, "alertWhatToDo"), tx("workerDownHint")) : "",
        actions({ href: systemUrl, label: tx("workerCta") }),
      ].join("\n"),
      footer: tx("workerFooter"),
    }),
    inlineImages: LOGO_IMAGES,
  };
}
