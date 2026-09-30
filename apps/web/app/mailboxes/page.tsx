"use client";

import Link from "next/link";
import { currentSyncError } from "@/lib/syncError";
import { useMailboxesList } from "@/hooks/useMailboxes";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { TableSkeleton } from "@/components/ui/LoadingState";
import { MailboxActions } from "@/components/mailboxes/MailboxActions";
import { formatRelativeTime } from "@/lib/format";
import { useHasPermission } from "@/hooks/useAuth";
import { Suspense } from "react";
import {
  ConnectWithProvider,
  OAuthResultBanner,
} from "@/components/mailboxes/ConnectWithProvider";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";

const AUTH_LABEL: Record<string, MessageKey> = {
  password: "mailboxes.authPassword",
  oauth_google: "mailboxes.authGoogle",
  oauth_microsoft: "mailboxes.authMicrosoft",
};

export default function MailboxesPage() {
  const mailboxes = useMailboxesList();
  const rows = mailboxes.data?.data ?? [];
  const canWrite = useHasPermission("mailboxes:write");
  const t = useT();

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-foreground">
            {t("mailboxes.title")}
          </h1>
          <p className="text-sm text-foreground-muted">
            {t("mailboxes.subtitle")}
          </p>
        </div>
        {canWrite ? (
          <div className="flex flex-wrap items-start gap-2">
            <ConnectWithProvider />
            <Link href="/mailboxes/new">
              <Button variant="primary">{t("mailboxes.newMailbox")}</Button>
            </Link>
          </div>
        ) : null}
      </header>

      <Suspense>
        <OAuthResultBanner />
      </Suspense>

      <div className="rounded-lg border border-border bg-surface-raised">
        {mailboxes.isPending ? (
          <TableSkeleton />
        ) : mailboxes.isError ? (
          <ErrorState
            error={mailboxes.error}
            onRetry={() => mailboxes.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title={t("mailboxes.emptyTitle")}
            description={t("mailboxes.emptyDescription")}
            action={
              canWrite ? (
                <Link href="/mailboxes/new">
                  <Button variant="secondary">
                    {t("mailboxes.newMailbox")}
                  </Button>
                </Link>
              ) : undefined
            }
          />
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>{t("mailboxes.columnAddress")}</Th>
                <Th>{t("mailboxes.columnStatus")}</Th>
                <Th>{t("mailboxes.columnSync")}</Th>
                <Th>{t("mailboxes.columnLastSuccess")}</Th>
                <Th>{t("mailboxes.columnActions")}</Th>
              </Tr>
            </Thead>
            <Tbody>
              {rows.map((mailbox) => (
                <Tr key={mailbox.id}>
                  <Td>
                    <p className="font-medium text-foreground">
                      {mailbox.name || mailbox.emailAddress}
                    </p>
                    <p className="text-xs text-foreground-subtle">
                      {mailbox.emailAddress} ·{" "}
                      {AUTH_LABEL[mailbox.authType]
                        ? t(AUTH_LABEL[mailbox.authType]!)
                        : mailbox.authType}{" "}
                      · {mailbox.host}
                    </p>
                  </Td>
                  <Td>
                    <StatusBadge status={mailbox.status} />
                  </Td>
                  <Td>
                    <StatusBadge status={mailbox.syncStatus} />
                    {currentSyncError(mailbox) ? (
                      <p className="mt-1 max-w-[200px] truncate text-xs text-status-danger-fg" title={currentSyncError(mailbox) ?? undefined}>
                        {currentSyncError(mailbox)}
                      </p>
                    ) : null}
                  </Td>
                  <Td className="text-foreground-muted">
                    {mailbox.lastSyncSuccessAt
                      ? formatRelativeTime(mailbox.lastSyncSuccessAt)
                      : t("mailboxes.never")}
                  </Td>
                  <Td>
                    <MailboxActions mailbox={mailbox} />
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </div>
    </div>
  );
}
