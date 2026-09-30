import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type TimelineStepState = "done" | "current" | "pending" | "failed" | "skipped";

const DOT_CLASSES: Record<TimelineStepState, string> = {
  done: "bg-status-success-fg",
  current: "bg-status-info-fg",
  pending: "bg-status-neutral-fg/40",
  failed: "bg-status-danger-fg",
  skipped: "bg-status-neutral-fg/20",
};

export interface TimelineStep {
  key: string;
  state: TimelineStepState;
  title: ReactNode;
  detail?: ReactNode;
}

/**
 * A generic vertical step list — §8's processing timeline is the primary
 * caller (components/email/ProcessingTimeline.tsx), which is responsible for
 * mapping REAL backend state onto these steps; this component itself has no
 * knowledge of Email/ActionExecution and invents no state of its own.
 */
export function Timeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <ol className="space-y-0">
      {steps.map((step, i) => (
        <li key={step.key} className="relative flex gap-3 pb-6 last:pb-0">
          {i < steps.length - 1 ? <span className="absolute top-3 left-[5px] h-full w-px bg-border" aria-hidden="true" /> : null}
          <span
            className={cn("relative mt-1 h-2.5 w-2.5 shrink-0 rounded-full", DOT_CLASSES[step.state])}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <p className={cn("text-sm font-medium", step.state === "pending" || step.state === "skipped" ? "text-foreground-subtle" : "text-foreground")}>
              {step.title}
            </p>
            {step.detail ? <div className="mt-1 text-sm text-foreground-muted">{step.detail}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
