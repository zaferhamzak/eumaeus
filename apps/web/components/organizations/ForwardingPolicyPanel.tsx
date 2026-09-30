"use client";

import { useState } from "react";
import { useOrgPermissions } from "@/hooks/useAuth";
import { useUpdateOrganization } from "@/hooks/useOrganizations";
import { Button } from "@/components/ui/Button";
import { ApiRequestError } from "@/lib/api/client";
import type { OrganizationResponse } from "@/types/api";
import { useT } from "@/lib/i18n/I18nProvider";

const inputClass = "w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm";
const labelClass = "mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase";

/**
 * Organization-wide limits for forward channels. Both are enforced by the
 * backend again at send time, so tightening them here applies to channels
 * that already exist.
 */
export function ForwardingPolicyPanel({ organization }: { organization: OrganizationResponse }) {
  const t = useT();
  const canWrite = useOrgPermissions(organization.id).includes("organizations:write");
  const update = useUpdateOrganization(organization.id);
  const [limit, setLimit] = useState(organization.forwardDailyLimit);
  const [domains, setDomains] = useState(organization.forwardAllowedDomains.join("\n"));

  const parsedDomains = domains
    .split(/[\s,;]+/)
    .map((d) => d.trim())
    .filter(Boolean);
  const dirty = limit !== organization.forwardDailyLimit || parsedDomains.join("\n") !== organization.forwardAllowedDomains.join("\n");

  return (
    <div className="max-w-lg space-y-6">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate({ forwardDailyLimit: limit, forwardAllowedDomains: parsedDomains });
        }}
      >
        <p className="text-sm text-foreground-muted">{t("organizations.forwardingIntro")}</p>

        <label className="block text-sm">
          <span className={labelClass}>{t("organizations.forwardDailyLimit")}</span>
          <input
            type="number"
            min={0}
            max={10000}
            required
            value={limit}
            disabled={!canWrite}
            onChange={(e) => setLimit(Number(e.target.value))}
            className={`${inputClass} max-w-[160px]`}
          />
          <span className="mt-1 block text-[11px] text-foreground-subtle">{t("organizations.forwardDailyLimitHelp")}</span>
        </label>

        <label className="block text-sm">
          <span className={labelClass}>{t("organizations.allowedDomains")}</span>
          <textarea
            rows={4}
            value={domains}
            disabled={!canWrite}
            onChange={(e) => setDomains(e.target.value)}
            placeholder={"company.com\npartner.com"}
            className={`${inputClass} font-mono`}
          />
          <span className="mt-1 block text-[11px] text-foreground-subtle">{t("organizations.allowedDomainsHelp")}</span>
        </label>

        {update.isError ? (
          <p className="text-sm text-status-danger-fg" role="alert">
            {update.error instanceof ApiRequestError ? update.error.message : t("common.saveFailed")}
          </p>
        ) : null}
        {update.isSuccess && !dirty ? <p className="text-sm text-status-success-fg">{t("common.saved")}</p> : null}

        {canWrite ? (
          <Button type="submit" variant="primary" disabled={!dirty} loading={update.isPending}>
            {t("common.save")}
          </Button>
        ) : (
          <p className="text-xs text-foreground-subtle">{t("organizations.needWrite")}</p>
        )}
      </form>
      <EmailLanguageSection organization={organization} canWrite={canWrite} />
    </div>
  );
}

/**
 * Phase 21: the language of mail sent to people without a Eumaeus account
 * (forward recipients, the note on forwarded mail). Members get mail in their
 * own interface language. Saved on change, with its own mutation so its
 * Saved/Failed message doesn't mix with the forwarding form's.
 */
function EmailLanguageSection({ organization, canWrite }: { organization: OrganizationResponse; canWrite: boolean }) {
  const t = useT();
  const update = useUpdateOrganization(organization.id);
  const current: "en" | "tr" = organization.locale === "tr" ? "tr" : "en";
  const value = update.isPending ? (update.variables?.locale ?? current) : current;

  return (
    <section className="space-y-2 border-t border-border pt-4" aria-labelledby="email-language-title">
      <label className="block text-sm">
        <span id="email-language-title" className={labelClass}>
          {t("organizations.emailLanguageTitle")}
        </span>
        <select
          value={value}
          disabled={!canWrite || update.isPending}
          onChange={(e) => update.mutate({ locale: e.target.value === "tr" ? "tr" : "en" })}
          className="rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
        >
          <option value="en">{t("organizations.languageEnglish")}</option>
          <option value="tr">{t("organizations.languageTurkish")}</option>
        </select>
        <span className="mt-1 block text-[11px] text-foreground-subtle">{t("organizations.emailLanguageHelp")}</span>
      </label>
      {update.isError ? (
        <p className="text-sm text-status-danger-fg" role="alert">
          {update.error instanceof ApiRequestError ? update.error.message : t("common.saveFailed")}
        </p>
      ) : null}
      {update.isSuccess ? <p className="text-sm text-status-success-fg">{t("common.saved")}</p> : null}
    </section>
  );
}
