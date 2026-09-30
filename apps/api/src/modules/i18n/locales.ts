/** Phase 21: languages Eumaeus speaks (interface and the emails it sends). */
export const SUPPORTED_LOCALES = ["en", "tr"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export function toLocale(value: string | null | undefined, fallback: Locale = "en"): Locale {
  return value === "en" || value === "tr" ? value : fallback;
}
