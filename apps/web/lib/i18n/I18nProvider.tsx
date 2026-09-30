"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { LOCALE_COOKIE, type Locale } from "./locales";
import { makeTranslate, type Translate } from "./translate";
import { setFormatLocale } from "@/lib/format";

interface I18nContextValue {
  locale: Locale;
  t: Translate;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/** The root layout passes the locale it resolved on the server; client components read it with useT()/useLocale(). */
export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  // Plain (non-hook) formatters in lib/format.ts read this too.
  setFormatLocale(locale);
  const value = useMemo(() => ({ locale, t: makeTranslate(locale) }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): Translate {
  const ctx = useContext(I18nContext);
  // Outside the provider (isolated component tests): English.
  return ctx?.t ?? FALLBACK.t;
}

export function useLocale(): Locale {
  return useContext(I18nContext)?.locale ?? "en";
}

const FALLBACK = { t: makeTranslate("en") };

/**
 * Switches language: remembers it in the cookie the server reads, and (when
 * signed in) on the account, then reloads so every server- and client-rendered
 * string changes together.
 */
export async function changeLocale(locale: Locale, saveToAccount: (locale: Locale) => Promise<unknown>): Promise<void> {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  try {
    await saveToAccount(locale);
  } catch {
    // Not signed in (login page) or offline: the cookie alone still works.
  }
  window.location.reload();
}
