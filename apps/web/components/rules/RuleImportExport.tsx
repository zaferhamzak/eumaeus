"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { ApiRequestError } from "@/lib/api/client";
import {
  exportRules,
  importRules,
  type RuleImportRequest,
  type RuleImportResult,
} from "@/lib/api/rules";
import { useT } from "@/lib/i18n/I18nProvider";
import type { Translate } from "@/lib/i18n/translate";

const selectClass =
  "rounded-md border border-border-strong bg-surface-raised px-2 py-1.5 text-sm";

function errorText(error: unknown, t: Translate): string {
  return error instanceof ApiRequestError
    ? error.message
    : t("rules.ioErrorFallback");
}

/**
 * Phase 19: rule sets as JSON. Export downloads the active rules as a file
 * that can be imported into another organization or another Eumaeus; import
 * always shows a check first (nothing is saved) and only then imports.
 */
export function RuleImportExport({
  canWrite,
  canDelete,
}: {
  canWrite: boolean;
  canDelete: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const exporting = useMutation({
    mutationFn: exportRules,
    onSuccess: (file) => {
      const blob = new Blob([JSON.stringify(file, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const slug =
        file.organization
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "rules";
      a.href = url;
      a.download = `eumaeus-rules-${slug}-${file.exportedAt.slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
  });

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        loading={exporting.isPending}
        onClick={() => exporting.mutate()}
        title={t("rules.exportHint")}
      >
        {t("rules.exportJson")}
      </Button>
      {canWrite ? (
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          {t("rules.importJson")}
        </Button>
      ) : null}
      {exporting.isError ? (
        <span className="text-xs text-status-danger-fg" role="alert">
          {errorText(exporting.error, t)}
        </span>
      ) : null}
      {open ? (
        <ImportDialog canDelete={canDelete} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function ImportDialog({
  canDelete,
  onClose,
}: {
  canDelete: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [mode, setMode] = useState<"add" | "replace">("add");
  const [priorities, setPriorities] = useState<"keep" | "append">("append");
  const [checked, setChecked] = useState<{
    key: string;
    result: RuleImportResult;
  } | null>(null);
  const run = useMutation({
    mutationFn: (body: RuleImportRequest) => importRules(body),
  });
  const key = `${mode}|${priorities}|${text}`;
  const preview = checked?.key === key ? checked.result : null;
  const done = run.data && !run.data.dryRun ? run.data : null;

  function submit(dryRun: boolean) {
    let rules: unknown;
    try {
      rules = JSON.parse(text);
    } catch {
      setParseError(t("rules.invalidJson"));
      return;
    }
    setParseError(null);
    run.mutate(
      { rules, mode, priorities, dryRun },
      {
        onSuccess: (result) => {
          if (dryRun) setChecked({ key, result });
          else void queryClient.invalidateQueries({ queryKey: ["rules"] });
        },
      },
    );
  }

  async function loadFile(file: File | undefined) {
    if (!file) return;
    setText(await file.text());
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t("rules.importTitle")}
      className="max-w-2xl"
    >
      {done ? (
        <div className="space-y-3">
          <p className="text-sm text-foreground">
            {done.deactivated > 0
              ? t("rules.importDoneWithDeactivated", {
                  rules: t("rules.ruleCount", { count: done.created }),
                  previous: t("rules.previousRuleCount", { count: done.deactivated }),
                })
              : t("rules.importDone", { rules: t("rules.ruleCount", { count: done.created }) })}
          </p>
          <IssueList title={t("rules.warnings")} tone="warning" issues={done.warnings} />
          <div className="flex justify-end">
            <Button variant="primary" onClick={onClose}>
              {t("rules.close")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-foreground-subtle">
            {t.rich("rules.importHelp", { code: (c) => <code>{c}</code> })}
          </p>
          <input
            type="file"
            accept="application/json,.json"
            aria-label={t("rules.rulesFileAria")}
            onChange={(e) => void loadFile(e.target.files?.[0])}
            className="text-sm"
          />
          <textarea
            aria-label={t("rules.rulesJsonAria")}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={10}
            spellCheck={false}
            className="w-full rounded-md border border-border-strong bg-surface-raised p-2 font-mono text-xs"
            placeholder='{ "format": "eumaeus.rules", "version": 1, "rules": [ … ] }'
          />
          <div className="flex flex-wrap gap-2">
            <select
              aria-label={t("rules.currentRulesAria")}
              value={mode}
              onChange={(e) => setMode(e.target.value as "add" | "replace")}
              className={selectClass}
            >
              <option value="add">{t("rules.modeAdd")}</option>
              <option value="replace" disabled={!canDelete}>
                {t("rules.modeReplace")}
                {canDelete ? "" : t("rules.needsRulesDelete")}
              </option>
            </select>
            <select
              aria-label={t("rules.prioritiesAria")}
              value={priorities}
              onChange={(e) =>
                setPriorities(e.target.value as "keep" | "append")
              }
              className={selectClass}
            >
              <option value="append">{t("rules.prioritiesAppend")}</option>
              <option value="keep">
                {t("rules.prioritiesKeep")}
              </option>
            </select>
          </div>

          {parseError ? (
            <p className="text-sm text-status-danger-fg" role="alert">
              {parseError}
            </p>
          ) : null}
          {run.isError ? (
            <p className="text-sm text-status-danger-fg" role="alert">
              {errorText(run.error, t)}
            </p>
          ) : null}

          {preview ? (
            <div className="space-y-2 border border-border p-3">
              <p className="text-sm text-foreground">
                {preview.valid
                  ? t(mode === "replace" ? "rules.previewReadyReplace" : "rules.previewReady", {
                      rules: t("rules.ruleCount", { count: preview.rules.length }),
                    })
                  : t("rules.previewInvalid")}
              </p>
              <IssueList title={t("rules.errors")} tone="danger" issues={preview.errors} />
              <IssueList
                title={t("rules.warnings")}
                tone="warning"
                issues={preview.warnings}
              />
              {preview.valid ? (
                <ul className="max-h-40 overflow-y-auto text-xs text-foreground-muted">
                  {preview.rules.map((r, i) => (
                    <li key={i} className="font-mono">
                      #{r.priority} {r.name} → {r.destinationRef}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="secondary"
              disabled={!text.trim()}
              loading={run.isPending && run.variables?.dryRun}
              onClick={() => submit(true)}
            >
              {t("rules.check")}
            </Button>
            <Button
              variant="primary"
              disabled={!preview?.valid}
              loading={run.isPending && !run.variables?.dryRun}
              onClick={() => submit(false)}
            >
              {t("rules.import")}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function IssueList({
  title,
  tone,
  issues,
}: {
  title: string;
  tone: "danger" | "warning";
  issues: RuleImportResult["errors"];
}) {
  const t = useT();
  if (issues.length === 0) return null;
  return (
    <div>
      <p className="text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
        {title}
      </p>
      <ul
        className={`space-y-0.5 text-xs ${tone === "danger" ? "text-status-danger-fg" : "text-status-warning-fg"}`}
      >
        {issues.map((issue, i) => (
          <li key={i}>
            {t("rules.issueLine", { n: issue.index + 1, name: issue.name, message: issue.message })}
          </li>
        ))}
      </ul>
    </div>
  );
}
