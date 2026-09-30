import { forwardRef, useEffect, useRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/ui/Icon";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size"> {
  /** Visual "some but not all" state for a "select all" header checkbox — a real DOM property, not a CSS trick, so assistive tech reports it correctly. */
  indeterminate?: boolean;
}

/**
 * Theme-native replacement for the raw `<input type="checkbox">` (which
 * renders with the browser's default accent color, not this app's palette).
 * `appearance-none` + a manually drawn check icon so it matches the rest of
 * the control plane (accent fill when checked, same border tokens as every
 * other input) instead of looking like a stock OS widget.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { indeterminate = false, className, checked, ...props },
  forwardedRef,
) {
  const innerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (innerRef.current) innerRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <span className="relative inline-grid h-3.5 w-3.5 shrink-0 place-items-center">
      <input
        ref={(node) => {
          innerRef.current = node;
          if (typeof forwardedRef === "function") forwardedRef(node);
          else if (forwardedRef) forwardedRef.current = node;
        }}
        type="checkbox"
        checked={checked}
        className={cn(
          "peer col-start-1 row-start-1 h-3.5 w-3.5 shrink-0 appearance-none rounded-[3px] border border-border-strong bg-surface-raised",
          "checked:border-accent checked:bg-accent indeterminate:border-accent indeterminate:bg-accent",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
      <Icon
        name={indeterminate ? "minus" : "check"}
        size={10}
        className="pointer-events-none col-start-1 row-start-1 hidden text-accent-foreground peer-checked:block peer-indeterminate:block"
      />
    </span>
  );
});
