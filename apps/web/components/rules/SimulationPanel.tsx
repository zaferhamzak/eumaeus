"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ApiRequestError } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { useSimulation } from "@/hooks/useSimulation";
import { useMailboxesList } from "@/hooks/useMailboxes";
import { useCurrentOrganizationId } from "@/lib/currentOrganization";
import type { SimulationTarget } from "@/lib/api/simulations";
import type { SimulatedRoute } from "@/types/api";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";
import type { Translate } from "@/lib/i18n/translate";

const selectClass = "rounded-md border border-border-strong bg-surface-raised px-2 py-1.5 text-sm";

const PERIODS: Array<{ days: number | null; label: MessageKey }> = [
  { days: 7, label: "rules.simLast7Days" },
  { days: 30, label: "rules.simLast30Days" },
  { days: 90, label: "rules.simLast90Days" },
  { days: null, label: "rules.simAllTime" },
];

const DESCRIPTION: Record<"rule" | "graph" | "entry", MessageKey> = {
  rule: "rules.simDescriptionRule",
  graph: "rules.simDescriptionGraph",
  entry: "rules.simDescriptionEntry",
};

function destinationLabel(ref: string, t: Translate): string {
  if (ref === "human_review") return t("rules.humanReview");
  if (ref === "left_alone") return t("rules.leftAlone");
  return ref;
}

function routeLabel(route: SimulatedRoute | null, t: Translate): string {
  if (!route) return t("rules.notRoutedYet");
  return destinationLabel(route.destinationRef, t);
}

/**
 * "Try on past emails" (Phase 14): runs the draft the editor currently holds
 * over already-analyzed emails with the live engine's own decision logic and
 * shows what would change. Read-only — nothing is saved and no action runs.
 * `getTarget` returns the draft, or a message when the form isn't complete.
 */
export function SimulationPanel({ getTarget, noun }: { getTarget: () => SimulationTarget | { error: string }; noun: "rule" | "graph" | "entry" }) {
  const t = useT();
  const organizationId = useCurrentOrganizationId();
  const mailboxes = useMailboxesList(organizationId ?? undefined);
  const simulation = useSimulation();
  const [days, setDays] = useState<number | null>(30);
  const [mailboxId, setMailboxId] = useState("");
  const [limit, setLimit] = useState(200);
  const [formError, setFormError] = useState<string | null>(null);

  function run() {
    const target = getTarget();
    if ("error" in target) {
      setFormError(target.error);
      return;
    }
    setFormError(null);
    simulation.mutate({
      target,
      scope: {
        limit,
        ...(days ? { since: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString() } : {}),
        ...(mailboxId ? { mailboxConnectionIds: [mailboxId] } : {}),
      },
    });
  }

  const r = simulation.data;
  const maxCount = Math.max(1, ...(r?.byDestination.map((d) => d.count) ?? [1]));

  return (
    <section className="space-y-3 border border-border bg-surface-raised p-4 rounded-lg" aria-labelledby="simulation-title">
      <div>
        <h2 id="simulation-title" className="text-sm font-semibold text-foreground">
          {t("rules.simTitle")}
        </h2>
        <p className="text-xs text-foreground-subtle">
          {t(DESCRIPTION[noun])}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select aria-label={t("rules.simPeriodAria")} value={days ?? ""} onChange={(e) => setDays(e.target.value ? Number(e.target.value) : null)} className={selectClass}>
          {PERIODS.map((p) => (
            <option key={p.label} value={p.days ?? ""}>
              {t(p.label)}
            </option>
          ))}
        </select>
        <select aria-label={t("rules.simMailboxAria")} value={mailboxId} onChange={(e) => setMailboxId(e.target.value)} className={selectClass}>
          <option value="">{t("rules.simAllMailboxes")}</option>
          {(mailboxes.data?.data ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.emailAddress}
            </option>
          ))}
        </select>
        <select aria-label={t("rules.simLimitAria")} value={limit} onChange={(e) => setLimit(Number(e.target.value))} className={selectClass}>
          {[200, 500, 1000].map((n) => (
            <option key={n} value={n}>
              {t("rules.simNewest", { n })}
            </option>
          ))}
        </select>
        <Button type="button" variant="secondary" loading={simulation.isPending} onClick={run}>
          {t("rules.simRun")}
        </Button>
      </div>

      {formError ? (
        <p className="text-sm text-status-danger-fg" role="alert">
          {formError}
        </p>
      ) : null}
      {simulation.isError ? (
        <p className="text-sm text-status-danger-fg" role="alert">
          {simulation.error instanceof ApiRequestError ? simulation.error.message : t("rules.simFailed")}
        </p>
      ) : null}

      {r ? (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-4">
            {[
              { label: t("rules.simEmailsChecked"), value: r.evaluated },
              {
                label: t(noun === "rule" ? "rules.simRuleWouldTake" : noun === "entry" ? "rules.simEntryWouldCatch" : "rules.simRoutedByGraph"),
                value: r.draftMatched,
              },
              { label: t("rules.simWouldChange"), value: r.changed },
              { label: t("rules.humanReview"), value: r.byDestination.find((d) => d.destinationRef === "human_review")?.count ?? 0 },
            ].map((tile) => (
              <div key={tile.label} className="bg-surface-raised px-3 py-2">
                <dt className="text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{tile.label}</dt>
                <dd className="font-mono text-lg text-foreground tabular-nums">{tile.value}</dd>
              </div>
            ))}
          </dl>

          <ul className="space-y-0.5 text-xs text-foreground-subtle">
            {r.truncated ? <li>{t("rules.simTruncated", { n: r.evaluated })}</li> : null}
            {r.withoutAnalysis > 0 ? <li>{t("rules.simWithoutAnalysis", { n: r.withoutAnalysis })}</li> : null}
            {r.forcedToReview > 0 ? <li>{t("rules.simForcedToReview", { n: r.forcedToReview })}</li> : null}
            {r.decidedByAssignedGraph > 0 ? <li>{t("rules.simDecidedByGraph", { n: r.decidedByAssignedGraph })}</li> : null}
          </ul>

          {r.byDestination.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{t("rules.simWhereTheyGo")}</p>
              {r.byDestination.map((d) => (
                <div key={d.destinationRef} className="grid grid-cols-[minmax(0,160px)_1fr_40px] items-center gap-2 text-xs">
                  <span className="truncate font-mono text-foreground">{destinationLabel(d.destinationRef, t)}</span>
                  <span className="h-2 bg-surface" aria-hidden="true">
                    <span className="block h-2" style={{ width: `${(d.count / maxCount) * 100}%`, background: "var(--chart-1)" }} />
                  </span>
                  <span className="text-right font-mono text-foreground tabular-nums">{d.count}</span>
                </div>
              ))}
            </div>
          ) : null}

          {r.samples.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{r.changed > 0 ? t("rules.simExamplesChangesFirst") : t("rules.simExamples")}</p>
              <ul className="divide-y divide-border border border-border">
                {r.samples.map((s) => (
                  <li key={s.emailId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
                    <span className="min-w-0 flex-1">
                      <Link href={`/emails/${s.emailId}`} className="block truncate font-medium text-foreground hover:text-accent hover:underline">
                        {s.subject || t("rules.noSubject")}
                      </Link>
                      <span className="block truncate text-foreground-subtle">
                        {s.fromAddress} · {formatDateTime(s.receivedAt)}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="text-foreground-subtle">{routeLabel(s.before, t)}</span>
                      <span aria-hidden="true">→</span>
                      <Badge tone={s.changed ? "warning" : "neutral"} variant="pill">
                        {routeLabel(s.after, t)}
                      </Badge>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : r.evaluated === 0 ? (
            <p className="text-sm text-foreground-muted">{t("rules.simNoEmails")}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
