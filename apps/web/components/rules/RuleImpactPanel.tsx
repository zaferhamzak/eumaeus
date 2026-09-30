"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { formatDateTime } from "@/lib/format";
import type { RuleImpact, RuleImpactSample } from "@/lib/api/rules";
import { useT } from "@/lib/i18n/I18nProvider";
import type { Translate } from "@/lib/i18n/translate";

export function impactDestinationLabel(ref: string, t: Translate): string {
  if (ref === "human_review") return t("rules.humanReview");
  if (ref === "left_alone") return t("rules.leftAlone");
  return ref;
}

/** The junk-like destinations business mail would move to, labelled, for the "I understand…" confirmation. */
export function riskyDestinations(impact: RuleImpact, t: Translate): string {
  const refs = [...new Set(impact.risky.samples.map((s) => s.to))];
  return refs.map((r) => impactDestinationLabel(r, t)).join(", ");
}

const heading = "text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase";

function SampleRow({ sample, t }: { sample: RuleImpactSample; t: Translate }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
      <span className="min-w-0 flex-1">
        <Link href={`/emails/${sample.emailId}`} className="block truncate font-medium text-foreground hover:text-accent hover:underline">
          {sample.subject || t("rules.noSubject")}
        </Link>
        <span className="block truncate text-foreground-subtle">
          {sample.fromAddress} · {formatDateTime(sample.receivedAt)}
          {sample.reason ? ` · ${sample.reason}` : ""}
        </span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="text-foreground-subtle">{impactDestinationLabel(sample.from, t)}</span>
        <span aria-hidden="true">→</span>
        <Badge tone={sample.reason ? "danger" : "warning"} variant="pill">
          {impactDestinationLabel(sample.to, t)}
        </Badge>
      </span>
    </li>
  );
}

/**
 * What a rule create/edit/delete would do to recent emails (POST
 * /rules/impact, or the `details.impact` of a 409). Read-only.
 * `mode` picks the wording of the match tiles.
 */
export function RuleImpactPanel({ impact, mode }: { impact: RuleImpact; mode: "create" | "update" | "delete" }) {
  const t = useT();
  const tiles = [
    ...(mode !== "delete" ? [{ label: t("rules.impactDraftMatches"), value: impact.draftMatches }] : []),
    ...(mode !== "create" ? [{ label: t("rules.impactCurrentMatches"), value: impact.currentMatches }] : []),
    { label: t("rules.impactChanged"), value: impact.changed },
  ];

  return (
    <section className="space-y-3 border border-border bg-surface-raised p-4 rounded-lg" aria-labelledby="rule-impact-title">
      <div>
        <h2 id="rule-impact-title" className="text-sm font-semibold text-foreground">
          {t("rules.impactTitle")}
        </h2>
        <p className="text-xs text-foreground-subtle">{t("rules.impactChecked", { count: impact.evaluated, days: impact.days })}</p>
      </div>

      <dl className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-3">
        {tiles.map((tile) => (
          <div key={tile.label} className="bg-surface-raised px-3 py-2">
            <dt className={heading}>{tile.label}</dt>
            <dd className="font-mono text-lg text-foreground tabular-nums">{tile.value}</dd>
          </div>
        ))}
      </dl>

      {impact.risky.count > 0 ? (
        <div className="space-y-2 border border-status-danger-fg/40 bg-status-danger-bg p-3" role="alert">
          <p className="text-sm font-semibold text-status-danger-fg">{t("rules.impactRiskyTitle", { count: impact.risky.count, to: riskyDestinations(impact, t) })}</p>
          <p className="text-xs text-status-danger-fg">{t("rules.impactRiskyDescription")}</p>
          {impact.risky.samples.length > 0 ? (
            <ul className="divide-y divide-border border border-border bg-surface-raised">
              {impact.risky.samples.map((s) => (
                <SampleRow key={s.emailId} sample={s} t={t} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {impact.moves.length > 0 ? (
        <div className="space-y-1">
          <p className={heading}>{t("rules.impactMoves")}</p>
          <ul className="space-y-0.5 text-xs">
            {impact.moves.map((m) => (
              <li key={`${m.from}\u0000${m.to}`} className="flex items-center gap-1.5">
                <span className="text-foreground-muted">{impactDestinationLabel(m.from, t)}</span>
                <span aria-hidden="true">→</span>
                <span className="text-foreground">{impactDestinationLabel(m.to, t)}</span>
                <span className="ml-auto font-mono text-foreground tabular-nums">{m.count}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-foreground-muted">{t("rules.impactNoChange")}</p>
      )}

      {impact.shadowedBy.length > 0 ? (
        <div className="space-y-1">
          <p className={heading}>{t("rules.impactShadowedBy")}</p>
          <ul className="space-y-0.5 text-xs">
            {impact.shadowedBy.map((s) => (
              <li key={s.by} className="flex items-center gap-1.5">
                <span className="truncate text-foreground-muted">{s.by}</span>
                <span className="ml-auto font-mono text-foreground tabular-nums">{s.count}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {impact.warnings.length > 0 ? (
        <ul className="space-y-0.5 text-xs text-status-warning-fg">
          {impact.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}

      {impact.samples.length > 0 && impact.risky.count === 0 ? (
        <div className="space-y-1.5">
          <p className={heading}>{t("rules.simExamples")}</p>
          <ul className="divide-y divide-border border border-border">
            {impact.samples.map((s) => (
              <SampleRow key={s.emailId} sample={s} t={t} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/** Shown when a DELETE came back 409 with an impact: the deletion would move business mail to a junk-like destination. */
export function RuleDeleteImpactDialog({
  impact,
  loading,
  onConfirm,
  onCancel,
}: {
  impact: RuleImpact | null;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  // Tied to the impact it was given for: a new 409 needs a new acknowledgement.
  const [acknowledgedFor, setAcknowledgedFor] = useState<RuleImpact | null>(null);
  const acknowledged = impact !== null && acknowledgedFor === impact;
  const close = onCancel;
  const needsAck = (impact?.risky.count ?? 0) > 0;
  return (
    <Modal open={impact !== null} onClose={close} title={t("rules.deleteImpactTitle")} className="max-w-2xl">
      {impact ? (
        <div className="space-y-3">
          <p className="text-sm text-foreground-muted">{t("rules.deleteImpactDescription")}</p>
          <RuleImpactPanel impact={impact} mode="delete" />
          {needsAck ? (
            <label className="flex items-start gap-2 text-sm text-foreground">
              <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledgedFor(e.target.checked ? impact : null)} className="mt-0.5" />
              <span>{t("rules.impactAcknowledge", { to: riskyDestinations(impact, t) })}</span>
            </label>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" onClick={onConfirm} loading={loading} disabled={needsAck && !acknowledged}>
              {t("rules.deleteAnyway")}
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
