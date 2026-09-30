"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useEmail } from "@/hooks/useEmails";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { StatusBadge, describeStatus } from "@/components/ui/StatusBadge";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Tabs } from "@/components/ui/Tabs";
import { EmptyState } from "@/components/ui/EmptyState";
import { ProcessingTimeline } from "@/components/email/ProcessingTimeline";
import { AnalysisView } from "@/components/email/AnalysisView";
import { RoutingDecisionView } from "@/components/email/RoutingDecisionView";
import { ReprocessPanel } from "@/components/email/ReprocessPanel";
import { CorrectDestinationPanel } from "@/components/email/CorrectDestinationPanel";
import { ActionExecutionCard } from "@/components/email/ActionExecutionCard";
import { EmailBody } from "@/components/email/EmailBody";
import { EmailAuditTrail } from "@/components/email/EmailAuditTrail";
import { SenderAuthBadge } from "@/components/email/SenderAuthBadge";
import { formatBytes, formatDateTime } from "@/lib/format";
import type { BadgeTone } from "@/components/ui/Badge";
import { useT } from "@/lib/i18n/I18nProvider";
import { reviewReasonLabel } from "@/components/review/reviewReason";

const TONE_ICON: Record<BadgeTone, IconName> = {
  success: "check",
  warning: "alert",
  danger: "alert",
  info: "activity",
  neutral: "activity",
};

/**
 * The "decision block" header — visual pattern from the New UI reference
 * (icon chip + headline + a real latency figure), but every field here is
 * real: the status is whichever of RoutingDecision.status / Email.state is
 * most specific right now (never a fabricated "risk score" or "verdict"),
 * and the latency is Jev's own real AnalysisResult.latencyMs when present —
 * there is no equivalent "policy completed in Nms" figure to invent one for.
 */
function DecisionBlock({ email }: { email: ReturnType<typeof useEmail>["data"] }) {
  const t = useT();
  if (!email) return null;
  const status = email.routingDecision?.status ?? email.state;
  const { label, tone } = describeStatus(status, t);

  return (
    <div className="grid grid-cols-[34px_1fr_auto] items-center gap-3 border border-border bg-surface-raised p-3 rounded-lg">
      <div
        className="grid h-[34px] w-[34px] place-items-center border"
        style={{
          color: `var(--status-${tone}-fg)`,
          background: `var(--status-${tone}-bg)`,
          borderColor: `color-mix(in srgb, var(--status-${tone}-fg) 35%, transparent)`,
        }}
      >
        <Icon name={TONE_ICON[tone]} size={17} />
      </div>
      <div className="min-w-0">
        <span className="text-[8px] font-semibold tracking-wide text-foreground-subtle uppercase">{t("emails.currentDecision")}</span>
        <h2 className="truncate text-base font-semibold text-foreground">{label}</h2>
        {email.routingDecision?.destinationRef ? (
          <p className="truncate text-xs text-foreground-subtle">
            → <span className="text-foreground-muted">{email.routingDecision.destinationRef}</span>
          </p>
        ) : null}
      </div>
      {email.analysis?.latencyMs != null ? (
        <div className="text-right">
          <span className="block font-mono text-base text-foreground">{email.analysis.latencyMs}</span>
          <span className="block text-[8px] text-foreground-subtle">{t("emails.msToAnalyze")}</span>
        </div>
      ) : null}
    </div>
  );
}

export default function EmailDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [showBody, setShowBody] = useState(false);
  const email = useEmail(id, showBody);
  const t = useT();

  if (email.isPending) return <LoadingState label={t("emails.loadingEmail")} />;
  if (email.isError) return <ErrorState error={email.error} onRetry={() => email.refetch()} />;

  const e = email.data;

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <Link href="/emails" className="text-xs text-foreground-muted hover:text-accent hover:underline">
          {t("emails.backToList")}
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-foreground">{e.subject || t("emails.noSubject")}</h1>
          <StatusBadge status={e.state} />
        </div>
        <p className="text-sm text-foreground-muted">
          {t.rich("emails.fromTo", { b: (c) => <span className="font-medium text-foreground">{c}</span> }, { from: e.fromAddress, to: e.toAddresses.join(", ") })}
        </p>
        <p className="text-xs text-foreground-subtle">{t("emails.receivedAt", { time: formatDateTime(e.receivedAt) })}</p>
        <SenderAuthBadge captured={e.senderAuthCaptured} auth={e.senderAuth} />
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card>
            <CardHeader
              title={t("emails.message")}
              action={
                <Button variant="ghost" onClick={() => setShowBody((v) => !v)}>
                  {showBody ? t("emails.hideBody") : t("emails.showBody")}
                </Button>
              }
            />
            <CardBody className="space-y-4">
              {e.attachments.length > 0 ? (
                <div>
                  <p className="mb-1 text-xs font-medium text-foreground-muted">{t("emails.attachments")}</p>
                  <ul className="space-y-1">
                    {e.attachments.map((a, i) => (
                      <li key={i} className="flex items-center gap-2 text-sm text-foreground-muted">
                        <Badge tone="neutral">{a.contentType ?? t("emails.unknownType")}</Badge>
                        {/* Attachment filenames are untrusted, attacker-controlled text — rendered as an inert React text child only, never interpreted. */}
                        <span>{a.filename ?? t("emails.unnamed")}</span>
                        <span className="text-foreground-subtle">{formatBytes(a.size)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {showBody ? <EmailBody email={e} /> : <p className="text-sm text-foreground-subtle">{t("emails.bodyHidden")}</p>}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title={t("emails.processingTimeline")} />
            <CardBody>
              <ProcessingTimeline email={e} />
            </CardBody>
          </Card>
        </div>

        <div className="space-y-4">
          <DecisionBlock email={e} />

          <Card id="actions" className="overflow-hidden">
            <Tabs
              ariaLabel={t("emails.inspector")}
              tabs={[
                {
                  key: "signals",
                  label: t("emails.tabSignals"),
                  content: e.analysis ? (
                    <AnalysisView analysis={e.analysis} />
                  ) : (
                    <EmptyState title={t("emails.notAnalyzedTitle")} description={t("emails.notAnalyzedDescription")} />
                  ),
                },
                {
                  key: "routing",
                  label: t("emails.tabRouting"),
                  content: (
                    <div className="space-y-4">
                      {e.routingDecision ? (
                        <>
                          <RoutingDecisionView decision={e.routingDecision} />
                          <ReprocessPanel emailId={e.id} previous={e.previousRoutingDecisions ?? []} />
                          <CorrectDestinationPanel emailId={e.id} decision={e.routingDecision} />
                        </>
                      ) : (
                        <EmptyState title={t("emails.noDecisionTitle")} description={t("emails.noDecisionDescription")} />
                      )}
                      {e.actionExecutions.length > 0 ? (
                        <div className="space-y-2">
                          <p className="text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{t("emails.actionExecutions")}</p>
                          {e.actionExecutions.map((exec) => (
                            <ActionExecutionCard key={exec.id} execution={exec} siblings={e.actionExecutions} />
                          ))}
                        </div>
                      ) : null}
                      {e.reviewItems.length > 0 ? (
                        <div className="space-y-2">
                          <p className="text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">{t("emails.humanReview")}</p>
                          {e.reviewItems.map((item) => (
                            <Link key={item.id} href={`/review/${item.id}`} className="block border border-border p-2 hover:bg-surface">
                              <div className="flex items-center justify-between">
                                <StatusBadge status={item.status} dense />
                                <span className="text-xs text-foreground-subtle">{reviewReasonLabel(item.reason, t)}</span>
                              </div>
                            </Link>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ),
                },
                {
                  key: "history",
                  label: t("emails.tabHistory"),
                  content: <EmailAuditTrail emailId={e.id} />,
                },
              ]}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}
