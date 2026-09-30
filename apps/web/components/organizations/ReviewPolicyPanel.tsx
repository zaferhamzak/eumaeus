"use client";

import { useState, type CSSProperties } from "react";
import { useOrgPermissions } from "@/hooks/useAuth";
import { useUpdateOrganization } from "@/hooks/useOrganizations";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ApiRequestError } from "@/lib/api/client";
import type { OrganizationResponse } from "@/types/api";
import { useLocale, useT } from "@/lib/i18n/I18nProvider";

/**
 * Jev's `human_review_required` signal forces Human Review BEFORE any rule
 * runs (apps/api/src/modules/rules/evaluateRulesForEmail.ts). These two
 * org-level settings control that override — threshold and on/off. Editing
 * requires organizations:write on THIS organization (the backend checks the
 * URL's :id, not the header-selected org), so the check here is per-org too.
 */
export function ReviewPolicyPanel({ organization }: { organization: OrganizationResponse }) {
  const t = useT();
  const locale = useLocale();
  const canWrite = useOrgPermissions(organization.id).includes("organizations:write");
  const update = useUpdateOrganization(organization.id);
  const [enabled, setEnabled] = useState(organization.humanReviewSignalEnabled);
  const [threshold, setThreshold] = useState(organization.humanReviewSignalThreshold);
  const [digestEnabled, setDigestEnabled] = useState(organization.reviewDigestEnabled);
  const [digestInterval, setDigestInterval] = useState(organization.reviewDigestIntervalMinutes);
  const [notifyEnabled, setNotifyEnabled] = useState(organization.assignmentNotifyEnabled);
  const [notifyThreshold, setNotifyThreshold] = useState(String(organization.assignmentNotifyThreshold));
  const thresholdNumber = Number(notifyThreshold);
  const thresholdValid = Number.isInteger(thresholdNumber) && thresholdNumber >= 1 && thresholdNumber <= 100;

  const dirty =
    enabled !== organization.humanReviewSignalEnabled ||
    threshold !== organization.humanReviewSignalThreshold ||
    digestEnabled !== organization.reviewDigestEnabled ||
    digestInterval !== organization.reviewDigestIntervalMinutes ||
    notifyEnabled !== organization.assignmentNotifyEnabled ||
    thresholdNumber !== organization.assignmentNotifyThreshold;

  return (
    <form
      className="max-w-lg space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!thresholdValid) return;
        update.mutate({
          assignmentNotifyEnabled: notifyEnabled,
          assignmentNotifyThreshold: thresholdNumber,
          humanReviewSignalEnabled: enabled,
          humanReviewSignalThreshold: threshold,
          reviewDigestEnabled: digestEnabled,
          reviewDigestIntervalMinutes: digestInterval,
        });
      }}
    >
      <p className="text-sm text-foreground-muted">{t("organizations.reviewPolicyIntro")}</p>

      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={enabled} disabled={!canWrite} onChange={(e) => setEnabled(e.target.checked)} />
        <span className="text-foreground">{t("organizations.forceReview")}</span>
      </label>

      <label className={`block text-sm ${enabled ? "" : "opacity-50"}`}>
        <span className="mb-1 flex items-baseline justify-between text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
          <span>{t("organizations.threshold")}</span>
          <span className="font-mono text-sm normal-case text-foreground">{threshold.toFixed(2)}</span>
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={threshold}
          disabled={!canWrite || !enabled}
          onChange={(e) => setThreshold(Number(e.target.value))}
          // The filled part of the track (globals.css draws the slider from this).
          style={{ "--range-pct": `${threshold * 100}%` } as CSSProperties}
          className="w-full"
        />
        <span className="mt-1 flex justify-between text-[10px] text-foreground-subtle">
          <span>{t("organizations.thresholdLow")}</span>
          <span>{t("organizations.thresholdHigh")}</span>
        </span>
      </label>

      <div className="space-y-3 border-t border-border pt-4">
        <p className="text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{t("organizations.digestTitle")}</p>
        <p className="text-sm text-foreground-muted">{t("organizations.digestIntro")}</p>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={digestEnabled} disabled={!canWrite} onChange={(e) => setDigestEnabled(e.target.checked)} />
          <span className="text-foreground">{t("organizations.sendDigests")}</span>
        </label>
        <label className={`block text-sm ${digestEnabled ? "" : "opacity-50"}`}>
          <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{t("organizations.digestInterval")}</span>
          <select
            value={digestInterval}
            disabled={!canWrite || !digestEnabled}
            onChange={(e) => setDigestInterval(Number(e.target.value))}
            className="rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
          >
            {[15, 30, 60, 240, 1440].map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes < 60
                  ? t("organizations.intervalMinutes", { count: minutes })
                  : minutes === 1440
                    ? t("organizations.intervalDay")
                    : t("organizations.intervalHours", { count: minutes / 60 })}
              </option>
            ))}
            {[15, 30, 60, 240, 1440].includes(digestInterval) ? null : <option value={digestInterval}>{t("organizations.intervalMinutes", { count: digestInterval })}</option>}
          </select>
        </label>
        {organization.lastReviewDigestAt ? (
          <p className="text-[11px] text-foreground-subtle">
            {t("organizations.digestCoveredThrough", { date: new Date(organization.lastReviewDigestAt).toLocaleString(locale) })}
          </p>
        ) : null}
      </div>

      <div className="space-y-3 border-t border-border pt-4">
        <p className="text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{t("organizations.assignNotifyTitle")}</p>
        <p className="text-sm text-foreground-muted">{t("organizations.assignNotifyIntro")}</p>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={notifyEnabled} disabled={!canWrite} onChange={(e) => setNotifyEnabled(e.target.checked)} />
          <span className="text-foreground">{t("organizations.assignNotifyEnabled")}</span>
        </label>
        <label className={`block text-sm ${notifyEnabled ? "" : "opacity-50"}`}>
          <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{t("organizations.assignNotifyThreshold")}</span>
          <span className="flex items-center gap-2">
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={100}
              step={1}
              value={notifyThreshold}
              disabled={!canWrite || !notifyEnabled}
              onChange={(e) => setNotifyThreshold(e.target.value)}
              aria-invalid={!thresholdValid}
              className="w-20 rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
            />
            <span className="text-foreground-muted">{t("organizations.assignNotifyUnit")}</span>
          </span>
          <span className="mt-1 block text-[11px] text-foreground-subtle">
            {thresholdValid ? (thresholdNumber === 1 ? t("organizations.assignNotifyEach") : t("organizations.assignNotifyBatch", { count: thresholdNumber })) : null}
          </span>
          {!thresholdValid ? (
            <span className="mt-1 block text-[11px] text-status-danger-fg" role="alert">
              {t("organizations.assignNotifyInvalid")}
            </span>
          ) : null}
        </label>
      </div>

      {update.isError ? (
        <p className="text-sm text-status-danger-fg" role="alert">
          {update.error instanceof ApiRequestError ? update.error.message : t("common.saveFailed")}
        </p>
      ) : null}
      {update.isSuccess && !dirty ? <p className="text-sm text-status-success-fg">{t("organizations.reviewSaved")}</p> : null}

      {canWrite ? (
        <Button type="submit" variant="primary" disabled={!dirty || !thresholdValid} loading={update.isPending}>
          {t("common.save")}
        </Button>
      ) : (
        <p className="text-xs text-foreground-subtle">{t("organizations.needWrite")}</p>
      )}
    </form>
  );
}
