"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ApiRequestError } from "@/lib/api/client";
import { createMailbox } from "@/lib/api/mailboxes";
import { useQueryClient } from "@tanstack/react-query";
import { useT } from "@/lib/i18n/I18nProvider";
import type { Translate } from "@/lib/i18n/translate";

const EXAMPLE = `[
  {
    "name": "Support",
    "email": "support@example.com",
    "host": "imap.example.com",
    "port": 993,
    "tls": true,
    "folder": "INBOX",
    "username": "support@example.com",
    "password": "..."
  },
  {
    "name": "Security",
    "email": "security@example.com",
    "host": "imap.example.com",
    "port": 993,
    "tls": true,
    "folder": "INBOX",
    "username": "security@example.com",
    "password": "..."
  }
]`;

interface RowInput {
  name: string;
  email: string;
  host: string;
  port: number;
  tls: boolean;
  folder: string;
  username: string;
  password: string;
}

type RowResult = {
  email: string;
  status: "pending" | "succeeded" | "failed";
  message?: string;
};

function parseRows(
  t: Translate,
  raw: string,
): { rows: RowInput[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      error:
        e instanceof Error
          ? t("mailboxes.invalidJsonDetail", { message: e.message })
          : t("mailboxes.invalidJson"),
    };
  }
  if (!Array.isArray(parsed)) return { error: t("mailboxes.mustBeArray") };
  if (parsed.length === 0) return { error: t("mailboxes.arrayEmpty") };

  for (const [i, item] of parsed.entries()) {
    if (typeof item !== "object" || item === null)
      return { error: t("mailboxes.itemMustBeObject", { index: i }) };
    const row = item as Record<string, unknown>;
    for (const field of [
      "name",
      "email",
      "host",
      "username",
      "password",
    ] as const) {
      if (typeof row[field] !== "string" || !row[field])
        return {
          error: t("mailboxes.itemNonEmptyString", { index: i, field }),
        };
    }
    if (typeof row.port !== "number")
      return { error: t("mailboxes.itemPortNumber", { index: i }) };
    if (typeof row.tls !== "boolean")
      return { error: t("mailboxes.itemTlsBoolean", { index: i }) };
    if (typeof row.folder !== "string" || !row.folder)
      return {
        error: t("mailboxes.itemNonEmptyString", { index: i, field: "folder" }),
      };
  }
  return { rows: parsed as RowInput[] };
}

/**
 * Deploys multiple mailboxes under ONE organization at once, by calling the
 * real single-mailbox creation endpoint (POST /api/v1/mailboxes) once per
 * array entry, sequentially — there is no separate bulk-create endpoint on
 * the backend, and this doesn't invent one; it reuses exactly what already
 * works and exists, one call at a time, so a partial failure (e.g. one
 * duplicate email in the batch) is reported per-row instead of failing the
 * whole batch atomically or silently.
 */
export function BulkImportMailboxesForm({
  organizationId,
  onImported,
}: {
  organizationId: string;
  onImported: () => void;
}) {
  const queryClient = useQueryClient();
  const [raw, setRaw] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [results, setResults] = useState<RowResult[]>([]);
  const [running, setRunning] = useState(false);
  const t = useT();

  async function handleImport() {
    setParseError(null);
    const parsed = parseRows(t, raw);
    if ("error" in parsed) {
      setParseError(parsed.error);
      return;
    }

    setRunning(true);
    setResults(parsed.rows.map((r) => ({ email: r.email, status: "pending" })));

    for (const [i, row] of parsed.rows.entries()) {
      try {
        await createMailbox({ organizationId, ...row });
        setResults((prev) =>
          prev.map((r, idx) => (idx === i ? { ...r, status: "succeeded" } : r)),
        );
      } catch (error) {
        const message =
          error instanceof ApiRequestError
            ? error.message
            : t("mailboxes.createMailboxFailed");
        setResults((prev) =>
          prev.map((r, idx) =>
            idx === i ? { ...r, status: "failed", message } : r,
          ),
        );
      }
    }

    setRunning(false);
    await queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
    onImported();
  }

  return (
    <div className="space-y-3">
      <label className="block text-sm">
        <span className="mb-1 block text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
          {t("mailboxes.bulkLabel")}
        </span>
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder={EXAMPLE}
          rows={10}
          className="w-full rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 font-mono text-xs"
        />
      </label>

      {parseError ? (
        <p
          className="rounded-md bg-status-danger-bg px-3 py-2 text-sm text-status-danger-fg"
          role="alert"
        >
          {parseError}
        </p>
      ) : null}

      <Button
        type="button"
        variant="primary"
        loading={running}
        onClick={handleImport}
        disabled={!raw.trim()}
      >
        {t("mailboxes.importAll")}
      </Button>

      {results.length > 0 ? (
        <ul className="space-y-1 border border-border p-2">
          {results.map((r, i) => (
            <li
              key={i}
              className="flex items-center justify-between gap-2 text-xs"
            >
              <span className="truncate font-mono text-foreground-muted">
                {r.email}
              </span>
              {r.status === "pending" ? (
                <Badge tone="neutral">{t("mailboxes.resultPending")}</Badge>
              ) : r.status === "succeeded" ? (
                <Badge tone="success">{t("mailboxes.resultCreated")}</Badge>
              ) : (
                <span className="flex items-center gap-1.5">
                  <Badge tone="danger">{t("mailboxes.resultFailed")}</Badge>
                  <span className="max-w-[240px] truncate text-status-danger-fg">
                    {r.message}
                  </span>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
