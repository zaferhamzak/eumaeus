import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-status-neutral-bg text-status-neutral-fg",
  info: "bg-status-info-bg text-status-info-fg",
  success: "bg-status-success-bg text-status-success-fg",
  warning: "bg-status-warning-bg text-status-warning-fg",
  danger: "bg-status-danger-bg text-status-danger-fg",
};

const DOT_TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-status-neutral-fg",
  info: "bg-status-info-fg",
  success: "bg-status-success-fg",
  warning: "bg-status-warning-fg",
  danger: "bg-status-danger-fg",
};

// Only warning/danger tones pull the label's text color too — mirrors the
// New UI reference's `.verdict` treatment, where a "this needs attention"
// state is colored end-to-end but a routine/safe state stays neutral text
// with just a colored dot, so the eye is drawn to what actually needs it.
const DOT_TEXT_CLASSES: Record<BadgeTone, string> = {
  neutral: "text-foreground-muted",
  info: "text-foreground-muted",
  success: "text-foreground-muted",
  warning: "text-status-warning-fg",
  danger: "text-status-danger-fg",
};

/**
 * The base visual primitive — deliberately dumb (a tone + a label). Semantic
 * mapping from a BACKEND state string to a tone lives in StatusBadge.tsx,
 * never here and never duplicated per-page (§28: "do not duplicate styling
 * across pages"). `variant="dot"` is a denser presentation (small colored dot
 * + text, no pill background) for compact table rows / inspector panels —
 * same tone data, different chrome.
 */
export function Badge({ tone = "neutral", variant = "pill", children }: { tone?: BadgeTone; variant?: "pill" | "dot"; children: ReactNode }) {
  if (variant === "dot") {
    return (
      <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", DOT_TEXT_CLASSES[tone])}>
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT_TONE_CLASSES[tone])} aria-hidden="true" />
        {children}
      </span>
    );
  }
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium", TONE_CLASSES[tone])}>
      {children}
    </span>
  );
}
