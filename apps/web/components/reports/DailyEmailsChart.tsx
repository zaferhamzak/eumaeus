"use client";

import { useState } from "react";
import type { ReportDailyPoint } from "@/types/api";
import { useLocale, useT } from "@/lib/i18n/I18nProvider";

const HEIGHT = 180;
const PAD = { top: 12, right: 8, bottom: 22, left: 34 };
const GAP = 2; // surface gap between stacked segments

function niceMax(value: number): number {
  if (value <= 5) return 5;
  const pow = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => value / s <= 4) ?? 10 * pow;
  return Math.ceil(value / step) * step;
}

function dayLabel(day: string, locale: string, long = false): string {
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString(locale, long ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short" });
}

/**
 * Emails per day, split into spam and everything else (Phase 18). Two
 * series, so a legend is always shown; stacked on one baseline with a 2px
 * surface gap; hover (or focus) a day for its exact numbers. A table view
 * below carries the same data for screen readers and printouts.
 */
export function DailyEmailsChart({ daily }: { daily: ReportDailyPoint[] }) {
  const t = useT();
  const locale = useLocale();
  const [hover, setHover] = useState<number | null>(null);
  const width = 720;
  const innerW = width - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const max = niceMax(Math.max(1, ...daily.map((d) => d.emails)));
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const slot = innerW / Math.max(1, daily.length);
  const barW = Math.max(3, Math.min(22, slot * 0.62));
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(daily.length / 8);
  const active = hover !== null ? daily[hover] : undefined;

  return (
    <figure className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-foreground-muted" aria-hidden="true">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--chart-1)" }} /> {t("reports.legendOther")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--chart-2)" }} /> {t("reports.legendSpam")}
        </span>
        <span className="ml-auto min-h-[1rem] text-foreground">
          {active ? (
            t.rich(
              "reports.hoverDetails",
              { b: (c) => <b className="font-medium">{c}</b> },
              { day: dayLabel(active.day, locale, true), emails: active.emails, spam: active.spam, needsReply: active.needsReply },
            )
          ) : (
            <span className="text-foreground-subtle">{t("reports.hoverPrompt")}</span>
          )}
        </span>
      </div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${HEIGHT}`} className="h-auto w-full min-w-[480px]" role="img" aria-label={t("reports.chartAria")}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
              <text x={PAD.left - 6} y={y(t)} textAnchor="end" dominantBaseline="middle" fontSize={10} fill="var(--foreground-subtle)">
                {Math.round(t)}
              </text>
            </g>
          ))}
          {daily.map((d, i) => {
            const cx = PAD.left + slot * i + slot / 2;
            const other = d.emails - d.spam;
            const otherTop = y(other);
            const spamTop = y(d.emails);
            const baseline = y(0);
            return (
              <g
                key={d.day}
                tabIndex={0}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                aria-label={t("reports.dayAria", { day: dayLabel(d.day, locale, true), emails: d.emails, spam: d.spam })}
              >
                {/* Hit target wider than the bar. */}
                <rect x={cx - slot / 2} y={PAD.top} width={slot} height={innerH} fill={hover === i ? "var(--surface)" : "transparent"} />
                {other > 0 ? <rect x={cx - barW / 2} y={otherTop} width={barW} height={Math.max(1, baseline - otherTop)} rx={d.spam > 0 ? 0 : 3} fill="var(--chart-1)" /> : null}
                {d.spam > 0 ? (
                  <rect x={cx - barW / 2} y={spamTop} width={barW} height={Math.max(1, otherTop - spamTop - (other > 0 ? GAP : 0))} rx={3} fill="var(--chart-2)" />
                ) : null}
                {i % labelEvery === 0 ? (
                  <text x={cx} y={HEIGHT - 6} textAnchor="middle" fontSize={10} fill="var(--foreground-subtle)">
                    {dayLabel(d.day, locale)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-foreground-subtle">{t("reports.showAsTable")}</summary>
        <div className="mt-2 max-h-64 overflow-auto border border-border">
          <table className="w-full text-left tabular-nums">
            <thead className="bg-surface text-foreground-subtle">
              <tr>
                <th className="px-2 py-1 font-medium">{t("reports.colDay")}</th>
                <th className="px-2 py-1 font-medium">{t("reports.colEmails")}</th>
                <th className="px-2 py-1 font-medium">{t("reports.colSpam")}</th>
                <th className="px-2 py-1 font-medium">{t("reports.colNeedReply")}</th>
                <th className="px-2 py-1 font-medium">{t("reports.colReviewOpened")}</th>
                <th className="px-2 py-1 font-medium">{t("reports.colReviewResolved")}</th>
              </tr>
            </thead>
            <tbody>
              {daily.map((d) => (
                <tr key={d.day} className="border-t border-border text-foreground">
                  <td className="px-2 py-1">{dayLabel(d.day, locale, true)}</td>
                  <td className="px-2 py-1">{d.emails}</td>
                  <td className="px-2 py-1">{d.spam}</td>
                  <td className="px-2 py-1">{d.needsReply}</td>
                  <td className="px-2 py-1">{d.reviewOpened}</td>
                  <td className="px-2 py-1">{d.reviewResolved}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
