/** Shared date/time/relative-time formatting — one place so every page renders timestamps consistently. */

/**
 * Phase 21: the interface language, set by I18nProvider on every render, so
 * these plain functions (called from everywhere, not hooks) format for it.
 */
let formatLocale: string | undefined;
export function setFormatLocale(locale: string): void {
  formatLocale = locale;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(formatLocale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(formatLocale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  const diffSeconds = Math.round((now - then) / 1000);
  const rtf = new Intl.RelativeTimeFormat(formatLocale, { numeric: "auto", style: "short" });
  if (diffSeconds < 5) return rtf.format(0, "second");
  if (diffSeconds < 60) return rtf.format(-diffSeconds, "second");
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return rtf.format(-diffMinutes, "minute");
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return rtf.format(-diffHours, "hour");
  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 30) return rtf.format(-diffDays, "day");
  return formatDateTime(iso);
}

/** A number in the interface language's style (1,234 / 1.234). */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat(formatLocale).format(value);
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
