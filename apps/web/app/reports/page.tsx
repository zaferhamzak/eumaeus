"use client";

import { useState } from "react";
import { useHostReport, useReport } from "@/hooks/useOps";
import { useMailboxesList } from "@/hooks/useMailboxes";
import { useMe } from "@/hooks/useAuth";
import {
  setCurrentOrganizationId,
  useCurrentOrganizationId,
} from "@/lib/currentOrganization";
import { formatDateTime } from "@/lib/format";
import type { HostOrganizationRow, ReportResponse } from "@/types/api";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { DailyEmailsChart } from "@/components/reports/DailyEmailsChart";
import { BarList } from "@/components/reports/BarList";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";

const selectClass =
  "rounded-md border border-border-strong bg-surface-raised px-2 py-1.5 text-sm";
const DESTINATION_LABEL: Record<string, MessageKey> = {
  human_review: "reports.humanReview",
  left_alone: "reports.leftAlone",
};
const CHANNEL_LABEL: Record<string, MessageKey> = {
  archive: "reports.channelArchive",
  archive_undo: "reports.channelArchiveUndo",
  webhook: "reports.channelWebhook",
  forward: "reports.channelForward",
  flag: "reports.channelFlag",
  auto_reply: "reports.channelAutoReply",
};
/** Product names: never translated. */
const PRODUCT_CHANNEL_LABEL: Record<string, string> = {
  slack: "Slack",
  teams: "Teams",
  jira: "Jira",
  zendesk: "Zendesk",
};
const pct = (part: number, whole: number) =>
  whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";

function Tile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="bg-surface-raised px-3 py-2.5" title={hint}>
      <dt className="text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
        {label}
      </dt>
      <dd className="font-mono text-xl text-foreground tabular-nums">
        {value}
      </dd>
    </div>
  );
}

/**
 * Phase 18: the organization's mail over 7, 30 or 90 days — what came in,
 * what Jev thought of it, where it went, which rules did the work, whether
 * actions succeeded, and how Human Review kept up. Days follow this
 * browser's time zone.
 *
 * Host view (superAdmin only): the same report summed over every active
 * organization, plus a table with one row per organization. Only here — the
 * rest of the app stays one organization at a time.
 */
export default function ReportsPage() {
  const t = useT();
  const organizationId = useCurrentOrganizationId();
  const me = useMe();
  const isHost = me.data?.user.isSuperAdmin === true;
  const [scope, setScope] = useState<"organization" | "all">("organization");
  const showAll = isHost && scope === "all";
  const mailboxes = useMailboxesList(
    showAll ? undefined : (organizationId ?? undefined),
  );
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [mailboxId, setMailboxId] = useState("");
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const report = useReport(
    { days, tz, ...(mailboxId ? { mailboxId } : {}) },
    !showAll,
  );
  const hostReport = useHostReport({ days, tz }, showAll);
  const active = showAll ? hostReport : report;
  const r = active.data;
  const orgNames =
    showAll && hostReport.data
      ? new Map(hostReport.data.organizations.map((o) => [o.tenantId, o.name]))
      : undefined;

  function openOrganization(id: string) {
    setCurrentOrganizationId(id);
    setScope("organization");
    setMailboxId("");
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">{t("reports.title")}</h1>
          <p className="text-sm text-foreground-muted">
            {showAll
              ? t("reports.subtitleAll")
              : t("reports.subtitleOrg")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isHost ? (
            <div
              role="group"
              aria-label={t("reports.scopeAria")}
              className="inline-flex rounded-md border border-border-strong text-sm"
            >
              {(
                [
                  ["organization", "reports.scopeOrganization"],
                  ["all", "reports.scopeAll"],
                ] as const satisfies ReadonlyArray<readonly [string, MessageKey]>
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={scope === value}
                  onClick={() => setScope(value)}
                  className={`px-3 py-1.5 first:rounded-l-md last:rounded-r-md ${scope === value ? "bg-accent text-accent-foreground" : "bg-surface-raised text-foreground-muted hover:text-foreground"}`}
                >
                  {t(label)}
                </button>
              ))}
            </div>
          ) : null}
          <select
            aria-label={t("reports.periodAria")}
            value={days}
            onChange={(e) => setDays(Number(e.target.value) as 7 | 30 | 90)}
            className={selectClass}
          >
            <option value={7}>{t("reports.last7Days")}</option>
            <option value={30}>{t("reports.last30Days")}</option>
            <option value={90}>{t("reports.last90Days")}</option>
          </select>
          {showAll ? null : (
            <select
              aria-label={t("reports.mailboxAria")}
              value={mailboxId}
              onChange={(e) => setMailboxId(e.target.value)}
              className={selectClass}
            >
              <option value="">{t("reports.allMailboxes")}</option>
              {(mailboxes.data?.data ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.emailAddress}
                </option>
              ))}
            </select>
          )}
        </div>
      </header>

      {active.isPending ? (
        <LoadingState label={t("reports.building")} />
      ) : active.isError ? (
        <ErrorState error={active.error} onRetry={() => active.refetch()} />
      ) : r ? (
        <>
          {showAll && hostReport.data ? (
            <OrganizationsTable
              rows={hostReport.data.organizations}
              onOpen={openOrganization}
            />
          ) : null}
          <ReportBody r={r} orgNames={orgNames} />
        </>
      ) : null}
    </div>
  );
}

function OrganizationsTable({
  rows,
  onOpen,
}: {
  rows: HostOrganizationRow[];
  onOpen: (id: string) => void;
}) {
  const t = useT();
  const num = "py-1.5 px-2 text-right";
  return (
    <Card>
      <CardHeader title={t("reports.organizationsTitle", { n: rows.length })} />
      <CardBody>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-xs tabular-nums">
            <thead className="text-foreground-subtle">
              <tr>
                <th className="py-1 pr-2 font-medium">{t("reports.colOrganization")}</th>
                <th className="px-2 py-1 text-right font-medium">{t("reports.colMailboxes")}</th>
                <th className="px-2 py-1 text-right font-medium">{t("reports.colEmails")}</th>
                <th className="px-2 py-1 text-right font-medium">{t("reports.colSpam")}</th>
                <th className="px-2 py-1 text-right font-medium">
                  {t("reports.colNeedReply")}
                </th>
                <th className="px-2 py-1 text-right font-medium">
                  {t("reports.colWaitingReview")}
                </th>
                <th className="px-2 py-1 text-right font-medium">
                  {t("reports.colFailedActions")}
                </th>
                <th className="px-2 py-1 text-right font-medium">
                  {t("reports.colOpenAlerts")}
                </th>
                <th className="py-1 pl-2 font-medium">{t("reports.colLastEmail")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr
                  key={o.tenantId}
                  className={`border-t border-border ${o.status === "active" ? "text-foreground" : "text-foreground-subtle"}`}
                >
                  <td className="py-1.5 pr-2">
                    <button
                      type="button"
                      onClick={() => onOpen(o.tenantId)}
                      className="font-medium hover:text-accent hover:underline"
                      title={t("reports.openOrganizationReport")}
                    >
                      {o.name}
                    </button>
                    {o.status === "active" ? null : (
                      <span className="ml-1.5">
                        {t("reports.notInTotals", { status: o.status })}
                      </span>
                    )}
                  </td>
                  <td className={num}>{o.mailboxes}</td>
                  <td className={num}>{o.emails}</td>
                  <td className={num}>{o.spam}</td>
                  <td className={num}>{o.needsReply}</td>
                  <td
                    className={`${num} ${o.reviewOpenNow > 0 ? "text-status-warning-fg" : ""}`}
                  >
                    {o.reviewOpenNow}
                  </td>
                  <td
                    className={`${num} ${o.failedActions > 0 ? "text-status-danger-fg" : ""}`}
                  >
                    {o.failedActions}
                  </td>
                  <td
                    className={`${num} ${o.openAlerts > 0 ? "text-status-danger-fg" : ""}`}
                  >
                    {o.openAlerts}
                  </td>
                  <td className="py-1.5 pl-2 whitespace-nowrap text-foreground-subtle">
                    {o.lastEmailAt ? formatDateTime(o.lastEmailAt) : t("reports.never")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  );
}

function ReportBody({
  r,
  orgNames,
}: {
  r: ReportResponse;
  orgNames?: Map<string, string>;
}) {
  const t = useT();
  return (
    <>
      <dl className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
        <Tile label={t("reports.tileEmails")} value={r.totals.emails} />
        <Tile
          label={t("reports.tileSpam")}
          value={pct(r.totals.spam, r.totals.analyzed)}
          hint={t("reports.spamHint", { spam: r.totals.spam, analyzed: r.totals.analyzed })}
        />
        <Tile
          label={t("reports.tileNeedReply")}
          value={r.totals.needsReply}
          hint={t("reports.needReplyHint")}
        />
        <Tile label={t("reports.tileSentToReview")} value={r.totals.reviewOpened} />
        <Tile
          label={t("reports.tileWaitingReview")}
          value={r.totals.reviewOpenNow}
          hint={t("reports.openNowHint")}
        />
        <Tile
          label={t("reports.tileMedianReview")}
          value={
            r.totals.medianReviewHours === null
              ? "—"
              : t("reports.hours", { hours: r.totals.medianReviewHours })
          }
          hint={t("reports.medianReviewHint")}
        />
      </dl>

      <Card>
        <CardHeader title={t("reports.emailsPerDay")} />
        <CardBody>
          <DailyEmailsChart daily={r.daily} />
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("reports.categoriesTitle")} />
          <CardBody>
            <BarList
              rows={r.categories.map((c) => ({
                label: c.category,
                value: c.count,
              }))}
              emptyText={t("reports.noAnalyzed")}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={t("reports.whereEmailsWent")} />
          <CardBody>
            <BarList
              rows={r.destinations.map((d) => ({
                label: DESTINATION_LABEL[d.destinationRef] ? t(DESTINATION_LABEL[d.destinationRef]!) : d.destinationRef,
                value: d.count,
              }))}
              emptyText={t("reports.noRouting")}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={t("reports.busiestRules")} />
          <CardBody>
            <BarList
              rows={r.rules.map((x) => ({
                label: orgNames
                  ? `${x.name} · ${orgNames.get(x.tenantId) ?? "?"}`
                  : x.name,
                value: x.matches,
              }))}
              emptyText={t("reports.noRuleMatched")}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={t("reports.actions")} />
          <CardBody>
            {r.actions.length === 0 ? (
              <p className="text-sm text-foreground-muted">
                {t("reports.noActions")}
              </p>
            ) : (
              <table className="w-full text-left text-xs tabular-nums">
                <thead className="text-foreground-subtle">
                  <tr>
                    <th className="py-1 font-medium">{t("reports.colType")}</th>
                    <th className="py-1 text-right font-medium">{t("reports.colSucceeded")}</th>
                    <th className="py-1 text-right font-medium">{t("reports.colFailed")}</th>
                    <th className="py-1 text-right font-medium">{t("reports.colUnsure")}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.actions.map((a) => (
                    <tr
                      key={a.channelType}
                      className="border-t border-border text-foreground"
                    >
                      <td className="py-1.5">
                        {CHANNEL_LABEL[a.channelType] ? t(CHANNEL_LABEL[a.channelType]!) : (PRODUCT_CHANNEL_LABEL[a.channelType] ?? a.channelType)}
                      </td>
                      <td className="py-1.5 text-right">{a.succeeded}</td>
                      <td
                        className={`py-1.5 text-right ${a.failed > 0 ? "text-status-danger-fg" : ""}`}
                      >
                        {a.failed}
                      </td>
                      <td
                        className={`py-1.5 text-right ${a.ambiguous > 0 ? "text-status-warning-fg" : ""}`}
                      >
                        {a.ambiguous}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>
      </div>
      <p className="text-[11px] text-foreground-subtle">
        {t("reports.timeZoneNote", { tz: r.timeZone })}
      </p>
    </>
  );
}
