import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-foreground hover:opacity-90",
  secondary: "bg-surface-raised text-foreground border border-border hover:bg-surface",
  danger: "bg-status-danger-bg text-status-danger-fg hover:opacity-90 border border-status-danger-fg/20",
  ghost: "text-foreground-muted hover:text-foreground hover:bg-surface",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
}

/** A real `<button>` element always (§32: "semantic buttons/links" — never a clickable `<div>`). Disabled + `aria-busy` while `loading`, with the label kept visible (not replaced by a spinner alone) so screen readers and sighted users both still know what the action was. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", loading, disabled, className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        VARIANT_CLASSES[variant],
        className,
      )}
      {...props}
    >
      {loading ? "…" : null}
      {children}
    </button>
  );
});
