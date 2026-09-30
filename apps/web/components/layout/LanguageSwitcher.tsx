"use client";

import { useEffect } from "react";
import { useMe } from "@/hooks/useAuth";
import { saveLocale } from "@/lib/api/auth";
import { changeLocale, useLocale, useT } from "@/lib/i18n/I18nProvider";
import { isLocale, LOCALE_COOKIE, LOCALE_NAMES, LOCALES } from "@/lib/i18n/locales";

/**
 * Phase 21: English / Türkçe. The choice is kept in a cookie (so the server
 * renders it) and on the account (so emails follow it). On a new browser with
 * no cookie yet, the account's saved choice is applied once.
 */
export function LanguageSwitcher({ saveToAccount = true }: { saveToAccount?: boolean }) {
  const locale = useLocale();
  const t = useT();
  const me = useMe();
  const accountLocale = saveToAccount ? me.data?.user.locale : undefined;

  useEffect(() => {
    const hasCookie = document.cookie.split(";").some((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
    if (!hasCookie && isLocale(accountLocale) && accountLocale !== locale) void changeLocale(accountLocale, async () => undefined);
  }, [accountLocale, locale]);

  return (
    <label className="flex items-center">
      <span className="sr-only">{t("common.language")}</span>
      <select
        value={locale}
        onChange={(e) => {
          const next = e.target.value;
          if (isLocale(next)) void changeLocale(next, saveToAccount ? saveLocale : async () => undefined);
        }}
        className="h-8 border border-border bg-surface px-1.5 text-[11px] text-foreground"
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {LOCALE_NAMES[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
