import type { ReactNode } from "react";

/** §36: every major page needs a MEANINGFUL empty state — this component just renders whatever specific copy the caller passes; it never supplies a generic "Nothing here" default on its own. */
export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? <p className="max-w-sm text-sm text-foreground-muted">{description}</p> : null}
      {action}
    </div>
  );
}
