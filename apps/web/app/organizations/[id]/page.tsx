"use client";

import { Suspense, use } from "react";
import { currentSyncError } from "@/lib/syncError";
import Link from "next/link";
import { useOrganization, useOrganizationsList } from "@/hooks/useOrganizations";
import { useMailboxesList } from "@/hooks/useMailboxes";
import { Card } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { EmptyState } from "@/components/ui/EmptyState";
import { Icon } from "@/components/ui/Icon";
import { Tabs } from "@/components/ui/Tabs";
import { CreateMailboxForm } from "@/components/mailboxes/CreateMailboxForm";
import { ConnectWithProvider, OAuthResultBanner } from "@/components/mailboxes/ConnectWithProvider";
import { OrganizationLifecycle } from "@/components/organizations/OrganizationLifecycle";
import { BulkImportMailboxesForm } from "@/components/mailboxes/BulkImportMailboxesForm";
import { MailboxActions } from "@/components/mailboxes/MailboxActions";
import { MembersPanel } from "@/components/organizations/MembersPanel";
import { ReviewPolicyPanel } from "@/components/organizations/ReviewPolicyPanel";
import { ForwardingPolicyPanel } from "@/components/organizations/ForwardingPolicyPanel";
import { AlertSettingsPanel } from "@/components/organizations/AlertSettingsPanel";
import { DataPrivacyPanel } from "@/components/organizations/DataPrivacyPanel";
import { ApiKeysPanel } from "@/components/organizations/ApiKeysPanel";
import { QuestionsPanel } from "@/components/organizations/QuestionsPanel";
import { BusinessHoursPanel } from "@/components/organizations/BusinessHoursPanel";
import { setCurrentOrganizationId, useCurrentOrganizationId } from "@/lib/currentOrganization";
import { formatRelativeTime } from "@/lib/format";
import { useT } from "@/lib/i18n/I18nProvider";

/**
 * Reconcile/Enable/Disable (via MailboxActions) hit PATCH/reconcile
 * endpoints, which are scoped by the X-Organization-Id header (the global
 * switcher in the Topbar) — NOT by which organization's page you happen to
 * be looking at. Determines whether the switcher is already pointed at THIS
 * organization, so mismatched actions (which would silently 404 against a
 * different organization) are hidden rather than offered.
 */
function useIsActiveOrganization(organizationId: string): boolean | undefined {
  const stored = useCurrentOrganizationId();
  const organizations = useOrganizationsList();

  if (stored) return stored === organizationId;

  const orgs = organizations.data?.data;
  if (!orgs || orgs.length === 0) return undefined;
  const earliest = [...orgs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  return earliest?.id === organizationId;
}

/**
 * Same icon-chip summary pattern as Email/Rule/Destination — the real stat
 * here is the organization's actual mailbox count (from the SAME
 * ?organizationId= listing the Mailboxes tab below uses), not a fabricated
 * health/activity score.
 */
function OrganizationSummary({ name, slug, status, mailboxCount }: { name: string; slug: string | null; status: string; mailboxCount: number }) {
  const t = useT();
  const tone = status === "active" ? "success" : "neutral";
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
        <Icon name="target" size={17} />
      </div>
      <div className="min-w-0">
        <span className="text-[8px] font-semibold tracking-wide text-foreground-subtle uppercase">{t("organizations.summaryLabel")}</span>
        <h1 className="truncate text-base font-semibold text-foreground">{name}</h1>
        {slug ? <p className="truncate font-mono text-xs text-foreground-subtle">{slug}</p> : null}
      </div>
      <div className="text-right">
        <span className="block font-mono text-base text-foreground">{mailboxCount}</span>
        <span className="block text-[8px] text-foreground-subtle">{t("organizations.mailboxCountLabel")}</span>
      </div>
    </div>
  );
}

export default function OrganizationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const t = useT();
  const { id } = use(params);
  const organization = useOrganization(id);
  const mailboxes = useMailboxesList(id);
  const isActiveOrg = useIsActiveOrganization(id);

  if (organization.isPending) return <LoadingState label={t("organizations.loadingOrganization")} />;
  if (organization.isError) return <ErrorState error={organization.error} onRetry={() => organization.refetch()} />;

  const org = organization.data;
  const rows = mailboxes.data?.data ?? [];

  return (
    <div className="space-y-4">
      <Link href="/organizations" className="text-xs text-foreground-muted hover:text-accent hover:underline">
        {t("organizations.backToList")}
      </Link>

      <OrganizationSummary name={org.name} slug={org.slug} status={org.status} mailboxCount={rows.length} />

      <Suspense>
        <OAuthResultBanner />
      </Suspense>

      <Card className="overflow-hidden">
        <Tabs
          ariaLabel={t("organizations.tabsAriaLabel")}
          tabs={[
            {
              key: "mailboxes",
              label: t("organizations.tabMailboxes"),
              content: mailboxes.isPending ? (
                <LoadingState label={t("organizations.loadingMailboxes")} />
              ) : mailboxes.isError ? (
                <ErrorState error={mailboxes.error} onRetry={() => mailboxes.refetch()} />
              ) : rows.length === 0 ? (
                <EmptyState title={t("organizations.mailboxesEmptyTitle")} description={t("organizations.mailboxesEmptyDescription")} />
              ) : (
                <ul className="divide-y divide-border">
                  {rows.map((mailbox) => (
                    <li key={mailbox.id} className="space-y-2 py-2.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">{mailbox.name || mailbox.emailAddress}</p>
                          <p className="truncate font-mono text-[10.5px] text-foreground-subtle">
                            {mailbox.emailAddress} · {mailbox.host}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <StatusBadge status={mailbox.status} dense />
                          <StatusBadge status={mailbox.syncStatus} dense />
                          <span className="text-[10px] text-foreground-subtle">{formatRelativeTime(mailbox.lastSyncAttemptAt ?? mailbox.createdAt)}</span>
                        </div>
                      </div>
                      {currentSyncError(mailbox) ? <p className="truncate text-[10.5px] text-status-danger-fg" title={currentSyncError(mailbox) ?? undefined}>{currentSyncError(mailbox)}</p> : null}
                      {isActiveOrg ? (
                        <MailboxActions mailbox={mailbox} />
                      ) : isActiveOrg === false ? (
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setCurrentOrganizationId(id);
                            window.location.reload();
                          }}
                        >
                          {t("organizations.switchToManage")}
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ),
            },
            {
              key: "add",
              label: t("organizations.tabAddMailbox"),
              content: (
                <div className="space-y-4">
                  {/* Phase 17 sign-in, for this organization; comes back to this page. */}
                  <div className="space-y-2 border-b border-border pb-4">
                    <p className="text-sm font-medium text-foreground">{t("organizations.addWithSignIn")}</p>
                    <p className="text-xs text-foreground-muted">{t("organizations.addWithSignInHelp")}</p>
                    <ConnectWithProvider organizationId={id} align="start" />
                  </div>
                  <p className="text-sm font-medium text-foreground">{t("organizations.addWithPassword")}</p>
                  <CreateMailboxForm fixedOrganizationId={id} onCreated={() => mailboxes.refetch()} />
                </div>
              ),
            },
            {
              key: "bulk",
              label: t("organizations.tabBulkImport"),
              content: <BulkImportMailboxesForm organizationId={id} onImported={() => mailboxes.refetch()} />,
            },
            {
              key: "members",
              label: t("organizations.tabMembers"),
              content: <MembersPanel organizationId={id} />,
            },
            {
              key: "review-policy",
              label: t("organizations.tabReviewPolicy"),
              content: <ReviewPolicyPanel
                  key={`${org.humanReviewSignalEnabled}-${org.humanReviewSignalThreshold}-${org.reviewDigestEnabled}-${org.reviewDigestIntervalMinutes}`}
                  organization={org}
                />,
            },
            {
              key: "forwarding",
              label: t("organizations.tabForwarding"),
              content: <ForwardingPolicyPanel key={`${org.forwardDailyLimit}-${org.forwardAllowedDomains.join(",")}`} organization={org} />,
            },
            {
              key: "alerts",
              label: t("organizations.tabAlerts"),
              content: <AlertSettingsPanel key={`${org.alertEmailsEnabled}-${org.alertWebhookOrigin ?? ""}`} organization={org} />,
            },
            {
              key: "privacy",
              label: t("organizations.tabPrivacy"),
              content: <DataPrivacyPanel key={`${org.bodyRetentionDays ?? ""}-${org.emailRetentionDays ?? ""}`} organization={org} />,
            },
            {
              key: "questions",
              label: t("organizations.tabQuestions"),
              content: <QuestionsPanel organizationId={org.id} />,
            },
            {
              key: "hours",
              label: t("organizations.tabHours"),
              content: <BusinessHoursPanel key={JSON.stringify(org.businessHours)} organization={org} />,
            },
            {
              key: "api-keys",
              label: t("organizations.tabApiKeys"),
              content: <ApiKeysPanel organizationId={org.id} />,
            },
          ]}
        />
      </Card>

      <OrganizationLifecycle organization={org} />
    </div>
  );
}
