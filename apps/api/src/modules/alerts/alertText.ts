import type { Locale } from "../i18n/locales.js";
import { emailText, type EmailTextKey } from "../i18n/emailText.js";

/**
 * 1.2 (E): an alert's title and detail in the reader's language, built from
 * its kind and params. `formatDate` turns an ISO time in the params into
 * readable text for this reader. Alerts saved before 1.2 have no params —
 * those keep their stored (English) text: null here.
 */
export function localizedAlertText(
  alert: { kind: string; params: unknown },
  locale: Locale,
  formatDate: (iso: string) => string,
): { title: string; detail: string } | null {
  if (!alert.params || typeof alert.params !== "object") return null;
  const params = Object.fromEntries(Object.entries(alert.params as Record<string, unknown>).map(([k, v]) => [k, typeof v === "number" ? v : String(v ?? "")]));
  const titleKey = `alertTitle_${alert.kind}` as EmailTextKey;
  if (emailText("en", titleKey) === titleKey) return null; // a kind this build doesn't know
  if (typeof params.since === "string" && params.since) params.since = formatDate(params.since);
  const detailKey = (alert.kind === "mailbox_sync_failing" && !params.since ? "alertDetail_mailbox_sync_failing_never" : `alertDetail_${alert.kind}`) as EmailTextKey;
  return { title: emailText(locale, titleKey, params), detail: emailText(locale, detailKey, params) };
}
