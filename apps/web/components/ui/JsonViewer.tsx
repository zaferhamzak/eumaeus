"use client";

import { useT } from "@/lib/i18n/I18nProvider";

/**
 * The "secondary raw details / developer view" (§9: "Do NOT dump raw JSON as
 * the primary interface... provide a secondary raw view if useful"). Built on
 * native <details>/<summary> — free keyboard/screen-reader disclosure
 * semantics, collapsed by default so it never competes with the human-
 * readable primary view for attention.
 *
 * Renders via a <pre> text node, never dangerouslySetInnerHTML — JSON.stringify
 * output is inert text, and React itself escapes it when interpolated as
 * children, so this is safe even if a value originated from untrusted email
 * content (§34).
 */
export function JsonViewer({ data, label }: { data: unknown; label?: string }) {
  const t = useT();
  return (
    <details className="rounded-md border border-border">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-foreground-muted hover:text-foreground">
        {label ?? t("common.rawDetails")}
      </summary>
      <pre className="overflow-x-auto border-t border-border bg-surface px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words">
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  );
}
