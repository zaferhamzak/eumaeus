"use client";

import { Modal } from "./Modal";
import { Button, type ButtonVariant } from "./Button";
import { useT } from "@/lib/i18n/I18nProvider";

/**
 * §39: destructive/irreversible-feeling actions (disable a destination,
 * delete a secret, deactivate a rule) must go through this — never the
 * browser's native `confirm()` — since the project now has a real dialog
 * system (Modal.tsx). Every caller must supply specific wording; there is no
 * generic default message, because a vague "Are you sure?" doesn't tell the
 * operator what will actually happen.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  confirmVariant = "danger",
  loading,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  confirmVariant?: ButtonVariant;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <Modal open={open} onClose={onCancel} title={title}>
      <p className="text-sm text-foreground-muted">{description}</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button variant={confirmVariant} onClick={onConfirm} loading={loading}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
