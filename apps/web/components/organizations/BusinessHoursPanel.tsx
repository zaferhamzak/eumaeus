"use client";

import { useMemo, useState } from "react";
import { useOrgPermissions } from "@/hooks/useAuth";
import { useUpdateOrganization } from "@/hooks/useOrganizations";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ApiRequestError } from "@/lib/api/client";
import type { OrganizationResponse } from "@/types/api";
import { useLocale, useT } from "@/lib/i18n/I18nProvider";

const inputClass =
  "rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm";
const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError ? error.message : fallback;
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function timeZones(current: string): string[] {
  const supported = (
    Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf;
  let zones: string[] = [];
  try {
    zones = supported ? supported("timeZone") : [];
  } catch {
    zones = [];
  }
  const all = new Set(zones);
  all.add(current);
  all.add("UTC");
  return [...all].sort();
}

/**
 * Phase 22: the organization's working hours, read by the rule condition
 * email.business_hours. Days are ISO weekdays (Mon=1 … Sun=7); an end earlier
 * than the start is an overnight window.
 */
export function BusinessHoursPanel({
  organization,
}: {
  organization: OrganizationResponse;
}) {
  const t = useT();
  const locale = useLocale();
  const canWrite = useOrgPermissions(organization.id).includes(
    "organizations:write",
  );
  const update = useUpdateOrganization(organization.id);
  const saved = organization.businessHours;
  const [timeZone, setTimeZone] = useState(
    saved?.timeZone ?? browserTimeZone(),
  );
  const [days, setDays] = useState<number[]>(saved?.days ?? [1, 2, 3, 4, 5]);
  const [start, setStart] = useState(saved?.start ?? "09:00");
  const [end, setEnd] = useState(saved?.end ?? "18:00");
  const zones = useMemo(() => timeZones(timeZone), [timeZone]);
  const weekdayNames = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, {
      weekday: "long",
      timeZone: "UTC",
    });
    // 2024-01-01 was a Monday.
    return DAYS.map((d) => format.format(new Date(Date.UTC(2024, 0, d))));
  }, [locale]);
  const overnight = start !== "" && end !== "" && end < start;
  const valid = days.length > 0 && start !== "" && end !== "" && start !== end;

  return (
    <div className="max-w-xl space-y-4">
      <p className="text-sm text-foreground-muted">
        {t.rich("organizations.hoursIntro", {
          code: (c) => <code className="font-mono text-xs">{c}</code>,
        })}
      </p>
      <p
        className={
          saved ? "text-xs text-foreground-subtle" : "text-sm text-status-warning-fg"
        }
      >
        {saved
          ? t("organizations.hoursCurrent", {
              days: saved.days
                .map((d) => weekdayNames[d - 1] ?? String(d))
                .join(", "),
              start: saved.start,
              end: saved.end,
              timeZone: saved.timeZone,
            })
          : t("organizations.hoursNotSet")}
      </p>

      <label className="block text-xs text-foreground-muted">
        {t("organizations.hoursTimeZone")}
        <select
          value={timeZone}
          disabled={!canWrite}
          onChange={(e) => setTimeZone(e.target.value)}
          aria-label={t("organizations.hoursTimeZone")}
          className={`${inputClass} mt-1 block w-full max-w-sm`}
        >
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="space-y-1.5">
        <legend className="text-xs text-foreground-muted">
          {t("organizations.hoursDays")}
        </legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {DAYS.map((d) => (
            <label
              key={d}
              className="flex items-center gap-1.5 text-sm text-foreground"
            >
              <Checkbox
                checked={days.includes(d)}
                disabled={!canWrite}
                onChange={(e) =>
                  setDays(
                    e.target.checked
                      ? [...days, d].sort((a, b) => a - b)
                      : days.filter((x) => x !== d),
                  )
                }
              />
              {weekdayNames[d - 1]}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap gap-3">
        <label className="block text-xs text-foreground-muted">
          {t("organizations.hoursStart")}
          <input
            type="time"
            value={start}
            disabled={!canWrite}
            onChange={(e) => setStart(e.target.value)}
            aria-label={t("organizations.hoursStart")}
            className={`${inputClass} mt-1 block`}
          />
        </label>
        <label className="block text-xs text-foreground-muted">
          {t("organizations.hoursEnd")}
          <input
            type="time"
            value={end}
            disabled={!canWrite}
            onChange={(e) => setEnd(e.target.value)}
            aria-label={t("organizations.hoursEnd")}
            className={`${inputClass} mt-1 block`}
          />
        </label>
      </div>
      <p className="text-[11px] text-foreground-subtle">
        {overnight
          ? t("organizations.hoursOvernightActive", { start, end })
          : t("organizations.hoursOvernightHint")}
      </p>
      {days.length === 0 ? (
        <p className="text-xs text-status-warning-fg">
          {t("organizations.hoursNoDays")}
        </p>
      ) : null}

      {update.isError ? (
        <p className="text-sm text-status-danger-fg" role="alert">
          {errorText(update.error, t("common.saveFailed"))}
        </p>
      ) : null}
      {update.isSuccess ? (
        <p className="text-sm text-status-success-fg">{t("common.saved")}</p>
      ) : null}
      {canWrite ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            loading={update.isPending && update.variables?.businessHours !== null}
            disabled={!valid}
            onClick={() =>
              update.mutate({ businessHours: { timeZone, days, start, end } })
            }
          >
            {t("common.save")}
          </Button>
          {saved ? (
            <Button
              variant="secondary"
              loading={update.isPending && update.variables?.businessHours === null}
              onClick={() => update.mutate({ businessHours: null })}
            >
              {t("organizations.hoursClear")}
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-foreground-subtle">
          {t("organizations.needWrite")}
        </p>
      )}
    </div>
  );
}
