"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useT } from "@/lib/i18n/I18nProvider";

/**
 * For what can't be undone (permanent deletion): the confirm button only
 * enables once the exact name is typed (case and surrounding spaces ignored,
 * as the API compares it).
 */
export function TypeToConfirmDialog({
  open,
  title,
  description,
  expected,
  confirmLabel,
  loading,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  expected: string;
  confirmLabel: string;
  loading?: boolean;
  error?: string | null;
  onConfirm: (typed: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [typed, setTyped] = useState("");
  const matches = typed.trim().toLowerCase() === expected.trim().toLowerCase();
  const close = () => {
    setTyped("");
    onCancel();
  };
  return (
    <Modal open={open} onClose={close} title={title}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (matches) onConfirm(typed);
        }}
        className="space-y-3"
      >
        <p className="text-sm text-foreground-muted">{description}</p>
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-foreground-muted">{t.rich("common.typeToConfirm", { b: (c) => <b className="font-mono text-foreground">{c}</b> }, { value: expected })}</span>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm"
          />
        </label>
        {error ? (
          <p className="text-sm text-status-danger-fg" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="danger" disabled={!matches} loading={loading}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
