"use client";

import { useState } from "react";
import {
  useDeleteMailboxPermanently,
  useSetMailboxStatus,
  useReconcileMailbox,
  useStartMailboxOAuth,
} from "@/hooks/useMailboxes";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TypeToConfirmDialog } from "@/components/ui/TypeToConfirmDialog";
import { UpdatePasswordDialog } from "@/components/mailboxes/UpdatePasswordDialog";
import { useMe } from "@/hooks/useAuth";
import { ApiRequestError } from "@/lib/api/client";
import type { MailboxConnectionResponse } from "@/types/api";
import { useT } from "@/lib/i18n/I18nProvider";

/**
 * Shared "Reconcile now" + Enable/Disable row actions — used by both the
 * Mailboxes page and an organization's own detail page, so the two never
 * drift into two different implementations of the same two real mutations.
 */
export function MailboxActions({
  mailbox,
}: {
  mailbox: MailboxConnectionResponse;
}) {
  const setStatus = useSetMailboxStatus();
  const reconcile = useReconcileMailbox();
  const reconnect = useStartMailboxOAuth();
  const oauthProvider =
    mailbox.authType === "oauth_google"
      ? "google"
      : mailbox.authType === "oauth_microsoft"
        ? "microsoft"
        : null;
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [justReconciled, setJustReconciled] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const usesPassword = mailbox.authType === "password";
  const remove = useDeleteMailboxPermanently();
  // Permanent deletion: system administrator only, and only once the mailbox is disabled.
  const canDelete = useMe().data?.user.isSuperAdmin === true && mailbox.status !== "active";
  const t = useT();

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          loading={reconcile.isPending}
          onClick={() => {
            setJustReconciled(true);
            reconcile.mutate(mailbox.id);
          }}
        >
          {t("mailboxes.reconcileNow")}
        </Button>
        {mailbox.status === "reauth_required" && oauthProvider ? (
          // The sign-in expired or was revoked: only signing in again fixes it.
          <Button
            variant="primary"
            loading={reconnect.isPending}
            onClick={() =>
              reconnect.mutate({
                provider: oauthProvider,
                mailboxConnectionId: mailbox.id,
              })
            }
          >
            {t("mailboxes.reconnect")}
          </Button>
        ) : mailbox.status === "reauth_required" && usesPassword ? (
          // The server kept rejecting the password: only a new one fixes it (saving it resumes syncing).
          <Button variant="primary" onClick={() => setPasswordOpen(true)}>
            {t("mailboxes.updatePassword")}
          </Button>
        ) : mailbox.status === "active" ? (
          <Button variant="danger" onClick={() => setConfirmDisable(true)}>
            {t("mailboxes.disable")}
          </Button>
        ) : (
          <Button
            variant="secondary"
            loading={setStatus.isPending}
            onClick={() =>
              setStatus.mutate({ id: mailbox.id, status: "active" })
            }
          >
            {t("mailboxes.enable")}
          </Button>
        )}
        {usesPassword && mailbox.status !== "reauth_required" ? (
          <Button variant="ghost" onClick={() => setPasswordOpen(true)}>
            {t("mailboxes.updatePassword")}
          </Button>
        ) : null}
        {canDelete ? (
          <Button variant="ghost" className="text-status-danger-fg" onClick={() => setConfirmDelete(true)}>
            {t("mailboxes.deletePermanently")}
          </Button>
        ) : null}
        {justReconciled && reconcile.isSuccess ? (
          <Badge tone="info">{t("mailboxes.reconciliationQueued")}</Badge>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmDisable}
        title={t("mailboxes.disableTitle")}
        description={t("mailboxes.disableDescription")}
        confirmLabel={t("mailboxes.disable")}
        loading={setStatus.isPending}
        onConfirm={() =>
          setStatus.mutate(
            { id: mailbox.id, status: "disabled" },
            { onSuccess: () => setConfirmDisable(false) },
          )
        }
        onCancel={() => setConfirmDisable(false)}
      />
      {usesPassword ? <UpdatePasswordDialog mailbox={mailbox} open={passwordOpen} onClose={() => setPasswordOpen(false)} /> : null}
      {canDelete ? (
        <TypeToConfirmDialog
          open={confirmDelete}
          title={t("mailboxes.deleteTitle", { address: mailbox.emailAddress })}
          description={t("mailboxes.deleteDescription")}
          expected={mailbox.emailAddress}
          confirmLabel={t("mailboxes.deletePermanently")}
          loading={remove.isPending}
          error={remove.error instanceof ApiRequestError ? remove.error.message : remove.error ? t("mailboxes.deleteFailed") : null}
          onConfirm={(typed) =>
            remove.mutate({ id: mailbox.id, confirmAddress: typed, organizationId: mailbox.organizationId }, { onSuccess: () => setConfirmDelete(false) })
          }
          onCancel={() => setConfirmDelete(false)}
        />
      ) : null}
    </>
  );
}
