"use client";

import { useRef } from "react";
import { useMe } from "@/hooks/useAuth";
import { useSettings, useUpdateSettings } from "@/hooks/useSettings";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { LoadingState } from "@/components/ui/LoadingState";
import { ErrorState } from "@/components/ui/ErrorState";
import { EmptyState } from "@/components/ui/EmptyState";
import { ApiRequestError } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import type { UpdateSettingsInput } from "@/lib/api/settings";
import { SmtpTransportFields } from "@/components/settings/SmtpTransportFields";
import { SmtpTestPanel } from "@/components/settings/SmtpTestPanel";
import { OAuthAppFields } from "@/components/settings/OAuthAppFields";
import { SsoFields } from "@/components/settings/SsoFields";
import { useT } from "@/lib/i18n/I18nProvider";

/**
 * superAdmin-only (the backend's own requireSuperAdmin gate is the real
 * enforcement — a non-superAdmin hitting this URL directly gets a real 403
 * from useSettings(), shown via ErrorState, not a fake client-side wall).
 * The SMTP password field is uncontrolled (FormData-read-on-submit), same
 * security discipline as SetSecretForm.tsx — its real value never enters
 * React state, is never echoed back (the backend only ever returns
 * smtpPasswordSet: boolean), and the form is left blank on load by design so
 * there's nothing to accidentally leak into the DOM.
 */
export default function SettingsPage() {
  const t = useT();
  const me = useMe();
  const settings = useSettings();
  const update = useUpdateSettings();
  const formRef = useRef<HTMLFormElement>(null);

  if (me.isPending || settings.isPending)
    return <LoadingState label={t("settings.loading")} />;
  if (settings.isError)
    return (
      <ErrorState error={settings.error} onRetry={() => settings.refetch()} />
    );
  if (!me.data?.user.isSuperAdmin) {
    return <EmptyState title={t("settings.superAdminOnly")} />;
  }

  const s = settings.data;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const smtpPassword = String(form.get("smtpPassword") ?? "");
    const input: UpdateSettingsInput = {
      appBaseUrl: String(form.get("appBaseUrl") ?? "").trim(),
      sessionTtlSeconds: Number(form.get("sessionTtlSeconds")),
      mailboxSyncIntervalSeconds: Number(
        form.get("mailboxSyncIntervalSeconds"),
      ),
      rawSourceRetentionDays: Number(form.get("rawSourceRetentionDays")),
      smtpHost: String(form.get("smtpHost") ?? "").trim() || null,
      smtpPort: Number(form.get("smtpPort")),
      smtpSecure: form.get("smtpSecure") === "on",
      smtpUsername: String(form.get("smtpUsername") ?? "").trim() || null,
      smtpFromAddress: String(form.get("smtpFromAddress") ?? "").trim() || null,
      smtpFromName: String(form.get("smtpFromName") ?? "").trim(),
      ...(form.get("confirmUnusualTls") === "on"
        ? { confirmUnusualTls: true }
        : {}),
      googleOAuthClientId:
        String(form.get("googleOAuthClientId") ?? "").trim() || null,
      microsoftOAuthClientId:
        String(form.get("microsoftOAuthClientId") ?? "").trim() || null,
      microsoftOAuthTenant:
        String(form.get("microsoftOAuthTenant") ?? "").trim() || "common",
      ssoGoogleEnabled: form.get("ssoGoogleEnabled") === "on",
      ssoMicrosoftEnabled: form.get("ssoMicrosoftEnabled") === "on",
      ssoAllowedDomains: String(form.get("ssoAllowedDomains") ?? "")
        .split(/[\s,]+/)
        .map((d) => d.trim())
        .filter(Boolean),
      // Secrets only when typed — blank means "keep the current one".
      ...(String(form.get("googleOAuthClientSecret") ?? "")
        ? {
            googleOAuthClientSecret: String(
              form.get("googleOAuthClientSecret"),
            ),
          }
        : {}),
      ...(String(form.get("microsoftOAuthClientSecret") ?? "")
        ? {
            microsoftOAuthClientSecret: String(
              form.get("microsoftOAuthClientSecret"),
            ),
          }
        : {}),
      // Only included if the admin actually typed something — leaving it
      // blank means "keep the current password," never "clear it" by accident.
      ...(smtpPassword ? { smtpPassword } : {}),
    };
    update.mutate(input, {
      onSuccess: () => {
        for (const name of [
          "smtpPassword",
          "googleOAuthClientSecret",
          "microsoftOAuthClientSecret",
        ]) {
          const field = formRef.current?.elements.namedItem(
            name,
          ) as HTMLInputElement | null;
          if (field) field.value = "";
        }
      },
    });
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="max-w-2xl space-y-4">
      <header>
        <h1 className="text-lg font-semibold text-foreground">{t("settings.title")}</h1>
        <p className="text-sm text-foreground-muted">
          {t("settings.subtitle")}
        </p>
        {s.updatedBy ? (
          <p className="mt-1 text-[11px] text-foreground-subtle">
            {t("settings.lastChanged", { user: s.updatedBy, date: formatDateTime(s.updatedAt) })}
          </p>
        ) : null}
      </header>

      <Card>
        <CardHeader title={t("settings.general")} />
        <CardBody className="space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
              {t("settings.appBaseUrl")}{" "}
              <span className="font-normal normal-case text-foreground-subtle">
                {t("settings.appBaseUrlHint")}
              </span>
            </span>
            <input
              name="appBaseUrl"
              type="url"
              required
              defaultValue={s.appBaseUrl}
              className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
                {t("settings.sessionTtl")}
              </span>
              <input
                name="sessionTtlSeconds"
                type="number"
                min={60}
                required
                defaultValue={s.sessionTtlSeconds}
                className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
                {t("settings.syncInterval")}
              </span>
              <input
                name="mailboxSyncIntervalSeconds"
                type="number"
                min={10}
                required
                defaultValue={s.mailboxSyncIntervalSeconds}
                className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
              />
            </label>
            <label className="col-span-2 block text-sm">
              <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
                {t("settings.rawRetention")}
              </span>
              <input
                name="rawSourceRetentionDays"
                type="number"
                min={0}
                max={365}
                required
                defaultValue={s.rawSourceRetentionDays}
                className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
              />
              <span className="mt-1 block text-xs text-foreground-subtle">
                {t("settings.rawRetentionHelp")}
              </span>
            </label>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t("settings.smtpTitle")} />
        <CardBody className="space-y-3">
          <p className="text-xs text-foreground-subtle">
            {t("settings.smtpIntro")}
          </p>
          <SmtpTransportFields
            key={`${s.smtpPort}-${s.smtpSecure}`}
            host={s.smtpHost}
            port={s.smtpPort}
            secure={s.smtpSecure}
          />
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
                {t("settings.username")}
              </span>
              <input
                name="smtpUsername"
                type="text"
                autoComplete="off"
                defaultValue={s.smtpUsername ?? ""}
                className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
                {t("settings.password")}{" "}
                {s.smtpPasswordSet ? (
                  <span className="font-normal normal-case text-status-success-fg">
                    {t("settings.setKeep")}
                  </span>
                ) : null}
              </span>
              <input
                name="smtpPassword"
                type="password"
                autoComplete="new-password"
                placeholder={s.smtpPasswordSet ? "••••••••" : ""}
                className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
                {t("settings.fromAddress")}
              </span>
              <input
                name="smtpFromAddress"
                type="email"
                placeholder={t("settings.fromAddressPlaceholder")}
                defaultValue={s.smtpFromAddress ?? ""}
                className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
                {t("settings.fromName")}
              </span>
              <input
                name="smtpFromName"
                type="text"
                required
                defaultValue={s.smtpFromName}
                className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
              />
            </label>
          </div>
          <SmtpTestPanel defaultTo={me.data.user.email} />
        </CardBody>
      </Card>

      {/* Linked from Mailboxes' "Connect Gmail" when it isn't set up yet. */}
      <Card id="mailbox-sign-in" className="scroll-mt-20">
        <CardHeader title={t("settings.oauthTitle")} />
        <CardBody>
          <OAuthAppFields s={s} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t("settings.ssoTitle")} />
        <CardBody>
          <SsoFields s={s} />
        </CardBody>
      </Card>

      {update.isError ? (
        <p className="text-sm text-status-danger-fg" role="alert">
          {update.error instanceof ApiRequestError
            ? update.error.message
            : t("settings.saveFailed")}
        </p>
      ) : null}
      {update.isSuccess ? (
        <p className="text-sm text-status-success-fg">{t("common.saved")}</p>
      ) : null}

      <Button type="submit" variant="primary" loading={update.isPending}>
        {t("settings.saveSettings")}
      </Button>
    </form>
  );
}
