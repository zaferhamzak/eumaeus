"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { ApiRequestError } from "@/lib/api/client";
import { downloadAuditCsv } from "@/lib/api/audit";
import { useT } from "@/lib/i18n/I18nProvider";

const inputClass =
  "h-7 border border-border bg-surface px-2 text-[11px] text-foreground";

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Phase 20: the audit log for a date range as a CSV file (at most 366 days).
 * "To" is inclusive here; the API's range is [from, to), so a day is added.
 */
export function AuditExport({ eventType }: { eventType?: string }) {
  const t = useT();
  const [from, setFrom] = useState(() =>
    isoDay(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
  );
  const [to, setTo] = useState(() => isoDay(new Date()));
  const download = useMutation({
    mutationFn: () => {
      const end = new Date(`${to}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 1);
      return downloadAuditCsv({
        from: `${from}T00:00:00Z`,
        to: end.toISOString(),
        eventType,
      });
    },
  });

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <input
        type="date"
        aria-label={t("audit.exportFrom")}
        value={from}
        max={to}
        onChange={(e) => setFrom(e.target.value)}
        className={inputClass}
      />
      <span className="text-[11px] text-foreground-subtle">{t("audit.exportRangeTo")}</span>
      <input
        type="date"
        aria-label={t("audit.exportTo")}
        value={to}
        min={from}
        onChange={(e) => setTo(e.target.value)}
        className={inputClass}
      />
      <Button
        type="button"
        variant="secondary"
        loading={download.isPending}
        disabled={!from || !to}
        onClick={() => download.mutate()}
        title={eventType ? t("audit.exportOnlyType", { type: eventType }) : t("audit.allEventTypes")}
      >
        {t("audit.exportCsv")}
      </Button>
      {download.isError ? (
        <span className="text-[11px] text-status-danger-fg" role="alert">
          {download.error instanceof ApiRequestError
            ? download.error.message
            : t("audit.exportFailed")}
        </span>
      ) : null}
    </div>
  );
}
