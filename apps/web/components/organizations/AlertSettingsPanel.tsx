"use client";

import { useState } from "react";
import { useOrgPermissions } from "@/hooks/useAuth";
import { useUpdateOrganization } from "@/hooks/useOrganizations";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ApiRequestError } from "@/lib/api/client";
import type { OrganizationResponse } from "@/types/api";
import { useT } from "@/lib/i18n/I18nProvider";

const inputClass = "w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm";

/**
 * Phase 18: who hears about operational problems. Alerts always show on the
 * Overview; here they can also go out by email (to members with
 * organizations:write) and to a webhook. The webhook URL may contain a token,
 * so it's write-only: only its origin is shown back.
 */
export function AlertSettingsPanel({ organization }: { organization: OrganizationResponse }) {
  const t = useT();
  const canWrite = useOrgPermissions(organization.id).includes("organizations:write");
  const update = useUpdateOrganization(organization.id);
  const [emails, setEmails] = useState(organization.alertEmailsEnabled);
  const [webhook, setWebhook] = useState("");

  return (
    <div className="max-w-lg space-y-4">
      <p className="text-sm text-foreground-muted">{t("organizations.alertsIntro")}</p>

      <label className="flex items-center gap-2 text-sm text-foreground">
        <Checkbox checked={emails} disabled={!canWrite} onChange={(e) => setEmails(e.target.checked)} />
        {t("organizations.alertEmails")}
      </label>

      <div className="space-y-1.5">
        <p className="text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{t("organizations.webhookTitle")}</p>
        {organization.alertWebhookOrigin ? (
          <p className="text-xs text-foreground-muted">
            {t.rich("organizations.webhookSendingTo", { mono: (c) => <span className="font-mono">{c}</span> }, { origin: organization.alertWebhookOrigin })}
            {canWrite ? (
              <button type="button" className="ml-2 text-status-danger-fg hover:underline" onClick={() => update.mutate({ alertWebhookUrl: null })}>
                {t("organizations.remove")}
              </button>
            ) : null}
          </p>
        ) : null}
        <input
          type="url"
          value={webhook}
          disabled={!canWrite}
          onChange={(e) => setWebhook(e.target.value)}
          placeholder={organization.alertWebhookOrigin ? t("organizations.webhookReplacePlaceholder") : "https://hooks.slack.com/services/…"}
          className={inputClass}
        />
        <p className="text-[11px] text-foreground-subtle">{t("organizations.webhookHelp")}</p>
      </div>

      {update.isError ? (
        <p className="text-sm text-status-danger-fg" role="alert">
          {update.error instanceof ApiRequestError ? update.error.message : t("common.saveFailed")}
        </p>
      ) : null}
      {update.isSuccess ? <p className="text-sm text-status-success-fg">{t("common.saved")}</p> : null}

      {canWrite ? (
        <Button
          variant="primary"
          loading={update.isPending}
          disabled={emails === organization.alertEmailsEnabled && !webhook.trim()}
          onClick={() => update.mutate({ alertEmailsEnabled: emails, ...(webhook.trim() ? { alertWebhookUrl: webhook.trim() } : {}) }, { onSuccess: () => setWebhook("") })}
        >
          {t("common.save")}
        </Button>
      ) : (
        <p className="text-xs text-foreground-subtle">{t("organizations.needWrite")}</p>
      )}
    </div>
  );
}
