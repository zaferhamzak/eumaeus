/**
 * Phase 21: the languages the interface speaks. The choice lives in a cookie
 * (read by the root layout on the server, so server and browser render the
 * same text — no hydration mismatch) and on the user's account (so emails
 * Eumaeus sends them use it too). Without either, the browser's
 * Accept-Language decides.
 */
export const LOCALES = ["en", "tr"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "jm_locale";

export const LOCALE_NAMES: Record<Locale, string> = { en: "English", tr: "Türkçe" };

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** The best supported language from an Accept-Language header ("tr-TR,tr;q=0.9,en;q=0.8" → "tr"). */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale {
  if (!header) return DEFAULT_LOCALE;
  const ranked = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { base: (tag ?? "").toLowerCase().split("-")[0] ?? "", q: q ? Number(q.slice(2)) : 1 };
    })
    .filter((x) => x.base && !Number.isNaN(x.q))
    .sort((a, b) => b.q - a.q);
  return ranked.map((x) => x.base).find(isLocale) ?? DEFAULT_LOCALE;
}
