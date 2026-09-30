"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ApiRequestError } from "@/lib/api/client";
import { useOrganizationsList } from "@/hooks/useOrganizations";
import { useCreateMailbox } from "@/hooks/useMailboxes";
import type { CreateMailboxInput } from "@/lib/api/mailboxes";
import { useT } from "@/lib/i18n/I18nProvider";
import type { Translate } from "@/lib/i18n/translate";

function validate(
  t: Translate,
  input: Omit<CreateMailboxInput, "password"> & { password: string },
): string[] {
  const errors: string[] = [];
  if (!input.organizationId) errors.push(t("mailboxes.errOrganization"));
  if (!input.name.trim()) errors.push(t("mailboxes.errName"));
  if (!input.email.trim()) errors.push(t("mailboxes.errEmail"));
  if (!input.host.trim()) errors.push(t("mailboxes.errHost"));
  if (!Number.isInteger(input.port) || input.port <= 0)
    errors.push(t("mailboxes.errPort"));
  if (!input.folder.trim()) errors.push(t("mailboxes.errFolder"));
  if (!input.username.trim()) errors.push(t("mailboxes.errUsername"));
  if (!input.password) errors.push(t("mailboxes.errPassword"));
  return errors;
}

/**
 * The password field is deliberately UNCONTROLLED — the same security
 * pattern SetSecretForm.tsx already established for destination secrets: the
 * raw value only ever exists as an <input> DOM value, never a `useState`
 * holding it, never logged, and the form resets immediately after a
 * successful submit so it doesn't linger in the DOM either. Every OTHER
 * field here is non-secret connection metadata and is controlled state,
 * exactly like RuleForm.
 */
export function CreateMailboxForm({
  onCreated,
  fixedOrganizationId,
}: {
  onCreated: (mailboxId: string) => void;
  /** When set, the organization is pre-selected and the picker is hidden entirely — used from an organization's own detail page, where the context is already unambiguous. */
  fixedOrganizationId?: string;
}) {
  const organizations = useOrganizationsList();
  const create = useCreateMailbox();
  const formRef = useRef<HTMLFormElement>(null);
  const t = useT();

  const [organizationId, setOrganizationId] = useState(
    fixedOrganizationId ?? "",
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(993);
  const [tls, setTls] = useState(true);
  const [folder, setFolder] = useState("INBOX");
  const [username, setUsername] = useState("");
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  const orgs = organizations.data?.data ?? [];

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const password = String(form.get("password") ?? "");

    const value = {
      organizationId,
      name,
      email,
      host,
      port,
      tls,
      folder,
      username,
      password,
    };
    const errors = validate(t, value);
    setValidationErrors(errors);
    if (errors.length > 0) return;

    create.mutate(value, {
      onSuccess: (mailbox) => {
        formRef.current?.reset();
        setName("");
        setEmail("");
        setHost("");
        setUsername("");
        onCreated(mailbox.id);
      },
    });
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {fixedOrganizationId ? null : (
          <label className="block text-sm sm:col-span-2">
            <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
              {t("mailboxes.fieldOrganization")}
            </span>
            <select
              value={organizationId}
              onChange={(e) => setOrganizationId(e.target.value)}
              required
              className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
            >
              <option value="">{t("mailboxes.selectOrganization")}</option>
              {orgs.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="block text-sm">
          <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
            {t("mailboxes.fieldDisplayName")}
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Support"
            required
            className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
            {t("mailboxes.fieldEmail")}
          </span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="support@example.com"
            required
            className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
          />
        </label>

        <label className="block text-sm">
          <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
            {t("mailboxes.fieldHost")}
          </span>
          <input
            type="text"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="imap.example.com"
            required
            className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm font-mono"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
            {t("mailboxes.fieldPort")}
          </span>
          <input
            type="number"
            value={port}
            onChange={(e) => setPort(e.target.valueAsNumber)}
            required
            className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm font-mono"
          />
        </label>

        <label className="block text-sm">
          <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
            {t("mailboxes.fieldFolder")}
          </span>
          <input
            type="text"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            required
            className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm font-mono"
          />
        </label>
        <label className="flex items-center gap-2 pt-5 text-sm">
          <Checkbox checked={tls} onChange={(e) => setTls(e.target.checked)} />
          <span className="text-foreground-muted">{t("mailboxes.useTls")}</span>
        </label>

        <label className="block text-sm">
          <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
            {t("mailboxes.fieldUsername")}
          </span>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
            {t("mailboxes.fieldPassword")}
          </span>
          <input
            name="password"
            type="password"
            autoComplete="off"
            required
            className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
          />
        </label>
      </div>

      {validationErrors.length > 0 ? (
        <ul
          className="space-y-1 rounded-md bg-status-danger-bg px-3 py-2 text-sm text-status-danger-fg"
          role="alert"
        >
          {validationErrors.map((err, i) => (
            <li key={i}>{err}</li>
          ))}
        </ul>
      ) : null}

      {create.isError ? (
        <p
          className="rounded-md bg-status-danger-bg px-3 py-2 text-sm text-status-danger-fg"
          role="alert"
        >
          {create.error instanceof ApiRequestError
            ? create.error.message
            : t("mailboxes.createMailboxFailed")}
        </p>
      ) : null}

      <Button type="submit" variant="primary" loading={create.isPending}>
        {t("mailboxes.createMailbox")}
      </Button>
    </form>
  );
}
