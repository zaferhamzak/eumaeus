import type { Locale } from "../i18n/locales.js";
import { EMAIL_LOGO_CID, EMAIL_LOGO_PNG } from "./emailLogo.js";
import type { InlineImage } from "./mailer.js";

/**
 * 1.0.2: the one frame every system email is drawn in — "Pine & Clay" in
 * email form: the logo and name on top, a white card with a coloured top
 * bar, a footer under it. Tables and inline styles only (that is what Gmail,
 * Outlook and Apple Mail agree on); no web fonts, no images except the logo,
 * which travels inline (cid:). Each template builds its card from the
 * helpers below and keeps its own plain-text part.
 *
 * Everything that reaches the HTML goes through escapeHtml — subjects,
 * senders and alert details can come from outside.
 */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export const COLORS = {
  page: "#f3f6f4",
  card: "#ffffff",
  border: "#dce3df",
  text: "#16211c",
  muted: "#5b6963",
  subtle: "#7d8a84",
  pine: "#10201a",
  accent: "#b4532f",
  accentDeep: "#8f3f22",
  accentSoft: "#fbe9e1",
  panel: "#f3f6f4",
} as const;

/** A moment in the recipient's language, with the zone named. */
export function formatEmailTime(date: Date, locale: Locale, timeZone: string): string {
  try {
    const text = new Intl.DateTimeFormat(locale === "tr" ? "tr-TR" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone }).format(date);
    return `${text} (${timeZone})`;
  } catch {
    return `${date.toISOString().slice(0, 16).replace("T", " ")} (UTC)`;
  }
}

/** "3 hours", "2 days" — the largest whole unit, in the recipient's language. */
export function formatEmailDuration(ms: number, locale: Locale): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const [value, unit] = minutes < 90 ? [minutes, "minute"] : minutes < 48 * 60 ? [Math.round(minutes / 60), "hour"] : [Math.round(minutes / 1440), "day"];
  return new Intl.NumberFormat(locale === "tr" ? "tr-TR" : "en-GB", { style: "unit", unit, unitDisplay: "long" }).format(value);
}

/** Badge and top-bar colours by meaning; the badge always says it in words too. */
export const TONES = {
  accent: { bar: "#b4532f", badgeBg: "#fbe9e1", badgeFg: "#8f3f22", mark: "●" },
  warning: { bar: "#c99a06", badgeBg: "#fdf3cf", badgeFg: "#7d5a00", mark: "●" },
  success: { bar: "#047857", badgeBg: "#e3f2eb", badgeFg: "#0b6146", mark: "✓" },
} as const;
export type Tone = keyof typeof TONES;

/** The logo every framed email carries; spread into the message as `inlineImages`. */
export const LOGO_IMAGES: InlineImage[] = [{ cid: EMAIL_LOGO_CID, filename: "eumaeus.png", content: EMAIL_LOGO_PNG, contentType: "image/png" }];

export function badge(text: string, tone: Tone): string {
  const t = TONES[tone];
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${t.badgeBg};color:${t.badgeFg};border-radius:999px;padding:4px 10px;font:700 11px/1.2 ${FONT};letter-spacing:0.6px;text-transform:uppercase;">${t.mark}&nbsp;${escapeHtml(text)}</td></tr></table>`;
}

/** Vertical space that Outlook respects too (it ignores heights on divs). */
export function spacer(px: number): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="height:${px}px;line-height:${px}px;font-size:1px;">&nbsp;</td></tr></table>`;
}

export function lead(text: string): string {
  return `<p style="margin:18px 0 6px;font:14px/1.5 ${FONT};color:${COLORS.muted};">${escapeHtml(text)}</p>`;
}

export function heading(text: string): string {
  return `<h1 style="margin:0 0 16px;font:700 20px/1.35 ${FONT};color:${COLORS.text};">${escapeHtml(text)}</h1>`;
}

export function paragraph(text: string): string {
  return `<p style="margin:0 0 16px;font:15px/1.6 ${FONT};color:${COLORS.text};">${escapeHtml(text)}</p>`;
}

/** Small grey print inside the card (link expiry, what the buttons do). */
export function note(text: string): string {
  return `<p style="margin:16px 0 0;font:12px/1.55 ${FONT};color:${COLORS.subtle};">${escapeHtml(text)}</p>`;
}

/** A grey box with a coloured left edge — for text quoted from elsewhere (an error, a server answer). */
export function quoteBox(text: string, tone: Tone): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;"><tr><td style="background:${COLORS.panel};border-left:3px solid ${TONES[tone].bar};border-radius:4px;padding:12px 14px;font:14px/1.55 ${FONT};color:${COLORS.text};white-space:pre-wrap;word-break:break-word;">${escapeHtml(text)}</td></tr></table>`;
}

/** Label / value rows between two hairlines. */
export function facts(rows: [string, string][]): string {
  const cells = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 0;font:13px/1.4 ${FONT};color:${COLORS.muted};width:120px;vertical-align:top;">${escapeHtml(label)}</td><td style="padding:6px 0;font:600 13px/1.4 ${FONT};color:${COLORS.text};vertical-align:top;">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${COLORS.border};border-bottom:1px solid ${COLORS.border};margin:0 0 20px;"><tr><td style="padding:6px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${cells}</table></td></tr></table>`;
}

/** The clay advice box ("What to do"). */
export function callout(title: string, body: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;"><tr><td style="background:${COLORS.accentSoft};border-radius:8px;padding:14px 16px;"><p style="margin:0 0 4px;font:700 13px/1.4 ${FONT};color:${COLORS.accentDeep};">${escapeHtml(title)}</p><p style="margin:0;font:14px/1.55 ${FONT};color:${COLORS.text};">${escapeHtml(body)}</p></td></tr></table>`;
}

/** The main button, optionally with a plain link beside it. */
export function actions(primary: { href: string; label: string }, secondary?: { href: string; label: string }): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${COLORS.accent};border-radius:8px;"><a href="${escapeHtml(primary.href)}" style="display:inline-block;padding:11px 20px;font:700 14px/1.2 ${FONT};color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(primary.label)} &rarr;</a></td>${
    secondary ? `<td style="padding-left:16px;"><a href="${escapeHtml(secondary.href)}" style="font:13px/1.2 ${FONT};color:${COLORS.accent};text-decoration:underline;">${escapeHtml(secondary.label)}</a></td>` : ""
  }</tr></table>`;
}

/** One email in a list (review digest, assignments): subject, sender and reason, optional small links. */
export function mailItem(item: { subject: string; from: string; reason: string; href?: string; links?: { href: string; label: string }[] }): string {
  const subject = item.href
    ? `<a href="${escapeHtml(item.href)}" style="color:${COLORS.text};text-decoration:none;">${escapeHtml(item.subject)}</a>`
    : escapeHtml(item.subject);
  const links = item.links?.length
    ? `<p style="margin:8px 0 0;font:600 12px/1.4 ${FONT};">${item.links
        .map((l) => `<a href="${escapeHtml(l.href)}" style="display:inline-block;margin-right:8px;padding:5px 10px;border:1px solid ${COLORS.border};border-radius:6px;color:${COLORS.accent};text-decoration:none;">${escapeHtml(l.label)}</a>`)
        .join("")}</p>`
    : "";
  return `<tr><td style="padding:12px 0;border-bottom:1px solid ${COLORS.border};"><p style="margin:0 0 3px;font:600 14px/1.4 ${FONT};color:${COLORS.text};word-break:break-word;">${subject}</p><p style="margin:0;font:13px/1.45 ${FONT};color:${COLORS.muted};word-break:break-word;">${escapeHtml(item.from)} · ${escapeHtml(item.reason)}</p>${links}</td></tr>`;
}

export function mailList(items: string[]): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${COLORS.border};margin:0 0 18px;">${items.join("")}</table>`;
}

/** The whole message: page, logo, card (with its top bar), footer. `body` is card HTML built from the helpers above. */
export function renderEmail(input: { locale: Locale; subject: string; preheader: string; tone: Tone; body: string; footer?: string }): string {
  return `<!doctype html>
<html lang="${input.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(input.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.page};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(input.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLORS.page};">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;">
        <tr>
          <td style="padding:0 4px 16px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="vertical-align:middle;"><img src="cid:${EMAIL_LOGO_CID}" width="32" height="32" alt="" style="display:block;border:0;border-radius:8px;"></td>
                <td style="vertical-align:middle;padding-left:10px;font:700 17px/1 ${FONT};color:${COLORS.pine};letter-spacing:-0.2px;">Eumaeus</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background:${COLORS.card};border:1px solid ${COLORS.border};border-top:4px solid ${TONES[input.tone].bar};border-radius:12px;padding:28px 28px 24px;">
            ${input.body}
          </td>
        </tr>${
          input.footer
            ? `
        <tr>
          <td style="padding:18px 8px 0;font:12px/1.55 ${FONT};color:${COLORS.subtle};">${escapeHtml(input.footer)}</td>
        </tr>`
            : ""
        }
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}
