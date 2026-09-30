"use client";

import { useState } from "react";
import { useUpdateMailboxPassword } from "@/hooks/useMailboxes";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { ApiRequestError } from "@/lib/api/client";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MailboxConnectionResponse } from "@/types/api";

const inputClass = "w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm";

/**
 * A new IMAP password for a password mailbox. Gmail (and Workspace) accept
 * only an app password for IMAP, so for imap.gmail.com the dialog says how
 * to get one. A mailbox stopped because its sign-in kept being rejected
 * resumes syncing when the new password is saved.
 */
export function UpdatePasswordDialog({ mailbox, open, onClose }: { mailbox: MailboxConnectionResponse; open: boolean; onClose: () => void }) {
  const t = useT();
  const update = useUpdateMailboxPassword();
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState(mailbox.username ?? "");
  const gmail = (mailbox.host ?? "").toLowerCase() === "imap.gmail.com";
  const close = () => {
    setPassword("");
    update.reset();
    onClose();
  };
  return (
    <Modal open={open} onClose={close} title={t("mailboxes.passwordTitle", { address: mailbox.emailAddress })}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!password) return;
          update.mutate(
            { id: mailbox.id, password, organizationId: mailbox.organizationId, ...(username.trim() && username.trim() !== mailbox.username ? { username: username.trim() } : {}) },
            { onSuccess: close },
          );
        }}
      >
        {mailbox.status === "reauth_required" ? <p className="text-sm text-status-danger-fg">{t("mailboxes.passwordRejectedNotice")}</p> : null}
        {gmail ? <p className="text-xs text-foreground-muted">{t.rich("mailboxes.gmailAppPasswordHelp", { b: (c) => <b className="text-foreground">{c}</b> })}</p> : null}
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-foreground-muted">{t("mailboxes.usernameLabel")}</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" className={inputClass} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-foreground-muted">{gmail ? t("mailboxes.appPasswordLabel") : t("mailboxes.newPasswordLabel")}</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" className={inputClass} />
        </label>
        {update.isError ? (
          <p className="text-sm text-status-danger-fg" role="alert">
            {update.error instanceof ApiRequestError ? update.error.message : t("mailboxes.passwordSaveFailed")}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!password} loading={update.isPending}>
            {t("mailboxes.savePassword")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
