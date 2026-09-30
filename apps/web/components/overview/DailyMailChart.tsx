"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { Card, CardHeader } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/LoadingState";
import { useLocale, useT } from "@/lib/i18n/I18nProvider";
import type { ReportResponse } from "@/types/api";

const W = 340;
const H = 170;
const PAD = { left: 30, right: 6, top: 12, bottom: 22 };

/** A "nice" axis maximum and three evenly spaced ticks for it. */
function axis(max: number): number[] {
  const raw = Math.max(max, 4) / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  return [0, step, step * 2, step * 3];
}

/**
 * The last 7 days: every email vs the ones Jev called spam, side by side per
 * day (one axis, one scale). The two colors are --chart-1 / --chart-2, a pair
 * validated for colour-vision deficiency; the legend and a per-bar tooltip
 * carry the identity as well, so it never depends on color alone.
 */
export function DailyMailChart({ report }: { report: UseQueryResult<ReportResponse> }) {
  const t = useT();
  const locale = useLocale();
  return (
    <Card className="flex h-full min-h-[300px] flex-col">
      <CardHeader title={t("overview.chartTitle")} action={<span className="text-xs text-foreground-muted">{t("overview.chartPeriod")}</span>} />
      <div className="flex flex-1 flex-col justify-center px-4 pt-3 pb-4">
        {report.isPending ? (
          <Skeleton className="h-[170px] w-full" />
        ) : report.isError ? (
          <ErrorState error={report.error} onRetry={() => report.refetch()} />
        ) : (
          <Chart days={report.data.daily.slice(-7)} locale={locale} labels={{ mail: t("overview.chartMail"), spam: t("overview.chartSpam") }} />
        )}
        <div className="mt-2 flex gap-4 text-xs text-foreground-muted">
          <span className="flex items-center gap-1.5">
            <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "var(--chart-1)" }} />
            {t("overview.chartMail")}
          </span>
          <span className="flex items-center gap-1.5">
            <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "var(--chart-2)" }} />
            {t("overview.chartSpam")}
          </span>
        </div>
      </div>
    </Card>
  );
}

function Chart({ days, locale, labels }: { days: ReportResponse["daily"]; locale: string; labels: { mail: string; spam: string } }) {
  const ticks = axis(Math.max(0, ...days.map((d) => d.emails)));
  const top = ticks[ticks.length - 1]!;
  const plotH = H - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const slot = (W - PAD.left - PAD.right) / days.length;
  const bar = Math.min(14, slot / 3);
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={labels.mail}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke={v === 0 ? "var(--border-strong)" : "var(--border)"} strokeWidth="1" />
          <text x={PAD.left - 6} y={y(v) + 3.5} textAnchor="end" fontSize="10" fill="var(--foreground-subtle)" className="tabular-nums">
            {Math.round(v)}
          </text>
        </g>
      ))}
      {days.map((d, i) => {
        const cx = PAD.left + slot * i + slot / 2;
        const label = weekday.format(new Date(`${d.day}T12:00:00Z`));
        return (
          <g key={d.day}>
            <rect x={cx - bar - 1} y={y(d.emails)} width={bar} height={Math.max(0, y(0) - y(d.emails))} rx="2" fill="var(--chart-1)">
              <title>{`${d.day} · ${labels.mail}: ${d.emails}`}</title>
            </rect>
            <rect x={cx + 1} y={y(d.spam)} width={bar} height={Math.max(0, y(0) - y(d.spam))} rx="2" fill="var(--chart-2)">
              <title>{`${d.day} · ${labels.spam}: ${d.spam}`}</title>
            </rect>
            <text x={cx} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--foreground-muted)">
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
