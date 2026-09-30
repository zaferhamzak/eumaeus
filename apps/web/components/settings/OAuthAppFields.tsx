"use client";

import { useState } from "react";
import type { SettingsResponse } from "@/types/api";
import { useT } from "@/lib/i18n/I18nProvider";

const inputClass = "w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm";
const labelClass = "mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase";

export function RedirectUri({ value }: { value: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate border border-border bg-surface px-2 py-1 font-mono text-[11px] text-foreground select-all">{value}</code>
      <button
        type="button"
        className="text-xs text-accent hover:underline"
        onClick={() => {
          navigator.clipboard?.writeText(value).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        {copied ? t("settings.copied") : t("settings.copy")}
      </button>
    </div>
  );
}

/**
 * Phase 17: the OAuth apps that let mailboxes be connected with "Sign in with
 * Google / Microsoft" instead of an app password. Uncontrolled like the rest of
 * the Settings form (read through FormData); secrets are never shown back.
 */
export function OAuthAppFields({ s }: { s: SettingsResponse }) {
  const t = useT();
  const code = (c: string) => <code className="font-mono">{c}</code>;
  return (
    <div className="space-y-5">
      <p className="text-xs text-foreground-subtle">{t("settings.oauthIntro")}</p>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-foreground">{t("settings.googleLegend")}</legend>
        <p className="text-xs text-foreground-subtle">{t.rich("settings.googleHelp", { code })}</p>
        <ol className="list-decimal space-y-0.5 pl-5 text-xs text-foreground-subtle">
          <li>{t.rich("settings.googleStep1", { code })}</li>
          <li>{t.rich("settings.googleStep2", { code })}</li>
          <li>{t.rich("settings.googleStep3", { code })}</li>
          <li>{t.rich("settings.googleStep4", { code })}</li>
        </ol>
        <span className={labelClass}>{t("settings.redirectUriLabel")}</span>
        <RedirectUri value={s.oauthRedirectUris.google} />
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className={labelClass}>{t("settings.clientId")}</span>
            <input name="googleOAuthClientId" type="text" autoComplete="off" defaultValue={s.googleOAuthClientId ?? ""} className={inputClass} />
          </label>
          <label className="block text-sm">
            <span className={labelClass}>
              {t("settings.clientSecret")}{" "}
              {s.googleOAuthClientSecretSet ? <span className="font-normal normal-case text-status-success-fg">{t("settings.setKeep")}</span> : null}
            </span>
            <input name="googleOAuthClientSecret" type="password" autoComplete="new-password" placeholder={s.googleOAuthClientSecretSet ? "••••••••" : ""} className={inputClass} />
          </label>
        </div>
      </fieldset>

      <fieldset className="space-y-2 border-t border-border pt-4">
        <legend className="text-sm font-medium text-foreground">{t("settings.microsoftLegend")}</legend>
        <p className="text-xs text-foreground-subtle">{t.rich("settings.microsoftHelp", { code })}</p>
        <span className={labelClass}>{t("settings.redirectUriLabel")}</span>
        <RedirectUri value={s.oauthRedirectUris.microsoft} />
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-sm">
            <span className={labelClass}>{t("settings.microsoftClientId")}</span>
            <input name="microsoftOAuthClientId" type="text" autoComplete="off" defaultValue={s.microsoftOAuthClientId ?? ""} className={inputClass} />
          </label>
          <label className="block text-sm">
            <span className={labelClass}>
              {t("settings.clientSecret")}{" "}
              {s.microsoftOAuthClientSecretSet ? <span className="font-normal normal-case text-status-success-fg">{t("settings.setShort")}</span> : null}
            </span>
            <input name="microsoftOAuthClientSecret" type="password" autoComplete="new-password" placeholder={s.microsoftOAuthClientSecretSet ? "••••••••" : ""} className={inputClass} />
          </label>
          <label className="block text-sm">
            <span className={labelClass}>{t("settings.tenant")}</span>
            <input name="microsoftOAuthTenant" type="text" defaultValue={s.microsoftOAuthTenant} placeholder="common" className={inputClass} />
          </label>
        </div>
        <p className="text-[11px] text-foreground-subtle">{t("settings.tenantHelp")}</p>
      </fieldset>
    </div>
  );
}
