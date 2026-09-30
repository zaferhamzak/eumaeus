"use client";

import { useState } from "react";
import Link from "next/link";
import { useHasPermission } from "@/hooks/useAuth";
import { useDestinationsList } from "@/hooks/useDestinations";
import { useCorrectEmail, useCorrectionRule } from "@/hooks/useEmails";
import { useCreateRule } from "@/hooks/useRules";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ConditionSummary } from "@/components/rules/ConditionSummary";
import { RuleImpactPanel, riskyDestinations } from "@/components/rules/RuleImpactPanel";
import { ApiRequestError } from "@/lib/api/client";
import { impactFromError, type RuleImpact } from "@/lib/api/rules";
import type { RoutingDecisionResponse } from "@/types/api";
import { useT } from "@/lib/i18n/I18nProvider";
import type { Translate } from "@/lib/i18n/translate";

const INBOX = "inbox";

const selectClass = "rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm";

function destinationLabel(ref: string | null | undefined, t: Translate): string {
  if (!ref || ref === "human_review") return t("emails.destHumanReview");
  if (ref === "left_alone" || ref === INBOX) return t("emails.correctLeftInInbox");
  return `"${ref}"`;
}

/** Where a decision sent the email, in the same vocabulary as the correct endpoint's `previousDestination`. */
function decisionDestination(decision: RoutingDecisionResponse): string {
  if (decision.status === "matched" && decision.destinationRef) return decision.destinationRef;
  if (decision.status === "sender_allowed") return "left_alone";
  return "human_review";
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError ? error.message : fallback;
}

/**
 * Phase 24: "this email belongs somewhere else". Moves it back (if the last
 * decision moved it), replaces the decision with the chosen destination and
 * runs its actions, then offers a rule so the same mistake doesn't repeat.
 */
export function CorrectDestinationPanel({ emailId, decision }: { emailId: string; decision: RoutingDecisionResponse }) {
  const t = useT();
  const canCorrect = useHasPermission("emails:reprocess") === true;
  if (!canCorrect) return null;
  return <CorrectDestinationForm emailId={emailId} decision={decision} t={t} />;
}

function CorrectDestinationForm({ emailId, decision, t }: { emailId: string; decision: RoutingDecisionResponse; t: Translate }) {
  const canReadRules = useHasPermission("rules:read") === true;
  const destinations = useDestinationsList();
  const correct = useCorrectEmail(emailId);
  const [target, setTarget] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [corrected, setCorrected] = useState<{ destinationRef: string; wrong: string | null } | null>(null);

  const current = decisionDestination(decision);

  function submit() {
    const destinationRef = target;
    setCorrected(null);
    correct.mutate(destinationRef, {
      onSuccess: (result) => setCorrected({ destinationRef, wrong: result.previousDestination }),
      onSettled: () => setConfirmOpen(false),
    });
  }

  return (
    <section className="space-y-3 border-t border-border pt-3" aria-labelledby="correct-destination-title">
      <div>
        <h3 id="correct-destination-title" className="text-sm font-semibold text-foreground">
          {t("emails.correctTitle")}
        </h3>
        <p className="text-xs text-foreground-muted">{t("emails.correctCurrent", { destination: destinationLabel(current, t) })}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select aria-label={t("emails.correctSelectAria")} value={target} onChange={(e) => setTarget(e.target.value)} className={selectClass}>
          <option value="">{t("emails.correctChoose")}</option>
          <option value={INBOX}>{t("emails.correctInbox")}</option>
          {(destinations.data?.data ?? []).map((d) => (
            <option key={d.id} value={d.name}>
              {d.name}
            </option>
          ))}
        </select>
        <Button variant="secondary" disabled={!target} loading={correct.isPending} onClick={() => setConfirmOpen(true)}>
          {t("emails.correctMove")}
        </Button>
      </div>

      {correct.isError ? (
        <p className="text-xs text-status-danger-fg" role="alert">
          {errorText(correct.error, t("emails.correctFailed"))}
        </p>
      ) : null}

      {corrected && correct.data ? (
        <p className="text-xs text-status-success-fg" role="status">
          {corrected.destinationRef === INBOX
            ? t("emails.correctDoneInbox")
            : correct.data.movedBack
              ? t("emails.correctDoneMovedBack", { destination: destinationLabel(corrected.destinationRef, t) })
              : t("emails.correctDone", { destination: destinationLabel(corrected.destinationRef, t) })}
        </p>
      ) : null}

      {corrected && canReadRules ? <CorrectionRuleDraftView key={`${corrected.destinationRef}\u0000${corrected.wrong ?? ""}`} emailId={emailId} params={corrected} t={t} /> : null}

      <ConfirmDialog
        open={confirmOpen}
        title={t("emails.correctConfirmTitle")}
        description={target === INBOX ? t("emails.correctConfirmDescriptionInbox") : t("emails.correctConfirmDescription", { destination: destinationLabel(target, t) })}
        confirmLabel={t("emails.correctMove")}
        confirmVariant="primary"
        loading={correct.isPending}
        onConfirm={submit}
        onCancel={() => setConfirmOpen(false)}
      />
    </section>
  );
}

function CorrectionRuleDraftView({ emailId, params, t }: { emailId: string; params: { destinationRef: string; wrong: string | null }; t: Translate }) {
  const canWriteRules = useHasPermission("rules:write") === true;
  const draft = useCorrectionRule(emailId, params);
  const create = useCreateRule();
  // A risky 409 carries its own impact; the acknowledgement is tied to it.
  const [riskyImpact, setRiskyImpact] = useState<RuleImpact | null>(null);
  const [acknowledgedFor, setAcknowledgedFor] = useState<RuleImpact | null>(null);
  const acknowledged = riskyImpact !== null && acknowledgedFor === riskyImpact;

  if (draft.isPending) return <p className="text-xs text-foreground-subtle">{t("emails.correctRuleLoading")}</p>;
  if (draft.isError) {
    return (
      <p className="text-xs text-status-danger-fg" role="alert">
        {errorText(draft.error, t("emails.correctRuleFailed"))}
      </p>
    );
  }

  const { rule, alsoWrong, impact } = draft.data;
  const shownImpact = riskyImpact ?? impact;

  function createRule() {
    create.mutate(
      { input: rule, confirmImpact: riskyImpact !== null ? true : undefined },
      {
        onError: (error) => {
          const fromError = impactFromError(error);
          if (fromError && fromError.risky.count > 0) setRiskyImpact(fromError);
        },
      },
    );
  }

  // The risky 409 is shown as the impact + acknowledgement, not as an error line.
  const createError = create.isError && !(riskyImpact !== null && impactFromError(create.error) !== null) ? create.error : null;
  const createdId = create.data?.id;

  return (
    <div className="space-y-3 border border-border bg-surface p-3">
      <div>
        <p className="text-sm font-semibold text-foreground">{t("emails.correctRuleTitle")}</p>
        <p className="text-xs text-foreground-muted">{t("emails.correctRuleHelp")}</p>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-foreground-subtle">{t("emails.correctRuleName")}</dt>
        <dd className="text-foreground">{rule.name}</dd>
        <dt className="text-foreground-subtle">{t("emails.correctRuleConditions")}</dt>
        <dd>
          <ConditionSummary condition={rule.conditions} />
        </dd>
        <dt className="text-foreground-subtle">{t("emails.correctRuleDestination")}</dt>
        <dd className="text-foreground">{destinationLabel(rule.destinationRef, t)}</dd>
        <dt className="text-foreground-subtle">{t("emails.correctRulePriority")}</dt>
        <dd className="font-mono text-foreground tabular-nums">{rule.priority}</dd>
      </dl>

      {alsoWrong > 0 && params.wrong ? (
        <p className="text-xs text-foreground-muted">{t("emails.correctAlsoWrong", { count: alsoWrong, wrong: destinationLabel(params.wrong, t) })}</p>
      ) : null}

      <RuleImpactPanel impact={shownImpact} mode="create" />

      {createdId ? (
        <p className="text-xs text-status-success-fg" role="status">
          {t.rich("emails.correctRuleCreated", {
            link: (c) => (
              <Link href={`/rules/${createdId}`} className="underline">
                {c}
              </Link>
            ),
          })}
        </p>
      ) : canWriteRules ? (
        <div className="space-y-2">
          {riskyImpact ? (
            <label className="flex items-start gap-2 text-sm text-foreground">
              <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledgedFor(e.target.checked ? riskyImpact : null)} className="mt-0.5" />
              <span>{t("rules.impactAcknowledge", { to: riskyDestinations(riskyImpact, t) })}</span>
            </label>
          ) : null}
          <Button variant={riskyImpact ? "danger" : "primary"} loading={create.isPending} disabled={riskyImpact !== null && !acknowledged} onClick={createRule}>
            {t("emails.correctRuleCreate")}
          </Button>
          {createError ? (
            <p className="text-xs text-status-danger-fg" role="alert">
              {errorText(createError, t("emails.correctRuleCreateFailed"))}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
