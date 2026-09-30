"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n/I18nProvider";

/**
 * Built on the native <dialog> element specifically for accessibility for
 * free (§32/§28): showModal() traps focus inside automatically, Escape
 * closes it automatically, and it has correct default ARIA semantics — none
 * of which a hand-rolled positioned <div> gets without a lot of extra work
 * this phase doesn't need to redo.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const t = useT();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      aria-labelledby="modal-title"
      className={cn(
        "w-full max-w-lg rounded-lg border border-border bg-surface-raised p-0 text-foreground shadow-xl backdrop:bg-black/40",
        className,
      )}
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 id="modal-title" className="text-sm font-semibold">
          {title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.closeDialog")}
          className="rounded p-1 text-foreground-muted hover:bg-surface hover:text-foreground"
        >
          ✕
        </button>
      </div>
      <div className="px-4 py-4">{children}</div>
    </dialog>
  );
}
