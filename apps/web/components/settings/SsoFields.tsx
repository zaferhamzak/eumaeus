"use client";

import type { SettingsResponse } from "@/types/api";
import { RedirectUri } from "./OAuthAppFields";
import { useT } from "@/lib/i18n/I18nProvider";
import { Checkbox } from "@/components/ui/Checkbox";

const labelClass =
  "mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase";

/**
 * Phase 20: single sign-on. Uses the same Google / Microsoft apps as mailbox
 * sign-in above, with a second redirect address. Only people who already have
 * a Eumaeus account can sign in this way; MFA still applies.
 */
export function SsoFields({ s }: { s: SettingsResponse }) {
  const t = useT();
  const googleReady = Boolean(
    s.googleOAuthClientId && s.googleOAuthClientSecretSet,
  );
  const microsoftReady = Boolean(
    s.microsoftOAuthClientId && s.microsoftOAuthClientSecretSet,
  );
  return (
    <div className="space-y-4">
      <p className="text-xs text-foreground-subtle">{t("settings.ssoIntro")}</p>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm text-foreground">
          <Checkbox
            name="ssoGoogleEnabled"
            defaultChecked={s.ssoGoogleEnabled}
            disabled={!googleReady}
          />
          {t("settings.ssoGoogle")}
          {googleReady ? "" : t("settings.ssoGoogleSetupFirst")}
        </label>
        {googleReady ? <RedirectUri value={s.ssoRedirectUris.google} /> : null}
      </div>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm text-foreground">
          <Checkbox
            name="ssoMicrosoftEnabled"
            defaultChecked={s.ssoMicrosoftEnabled}
            disabled={!microsoftReady}
          />
          {t("settings.ssoMicrosoft")}
          {microsoftReady ? "" : t("settings.ssoMicrosoftSetupFirst")}
        </label>
        {microsoftReady ? (
          <RedirectUri value={s.ssoRedirectUris.microsoft} />
        ) : null}
      </div>

      <label className="block text-sm">
        <span className={labelClass}>{t("settings.ssoAllowedDomains")}</span>
        <input
          name="ssoAllowedDomains"
          type="text"
          defaultValue={s.ssoAllowedDomains.join(", ")}
          placeholder="acme.com, acme.com.tr"
          className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
        />
        <span className="mt-1 block text-[11px] text-foreground-subtle">
          {t("settings.ssoAllowedDomainsHelp")}
        </span>
      </label>
    </div>
  );
}
