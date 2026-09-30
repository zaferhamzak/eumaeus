"use client";

import { useState } from "react";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useRetryActionExecution, useUndoActionExecution } from "@/hooks/useActionExecution";
import { useHasPermission } from "@/hooks/useAuth";
import { formatDateTime } from "@/lib/format";
import { ApiRequestError } from "@/lib/api/client";
import type { ActionExecutionResponse } from "@/types/api";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";

/**
 * §12/§13: displays real ActionExecution state, and offers Retry ONLY when
 * the fetched state already satisfies the backend's own precondition
 * (status="failed" && retryable=true) — the button's mere presence is never
 * the source of truth; the backend re-validates on every call regardless
 * (§16 adversarial item "retrying terminal actions incorrectly" — this
 * component structurally cannot offer retry for succeeded/ambiguous/
 * non-retryable-failed executions, and even if it somehow did, the backend
 * would reject it with 409/INVALID_STATE, which the mutation surfaces as an
 * error rather than a false success).
 */
const CHANNEL_LABEL: Record<string, MessageKey> = {
  archive: "emails.channelMove",
  archive_undo: "emails.channelUndoMove",
  flag: "emails.channelFlags",
  auto_reply: "emails.channelAutoReply",
};

const SKIP_REASON: Record<string, MessageKey> = {
  headers_unknown: "emails.skipHeadersUnknown",
  automated: "emails.skipAutomated",
  mailing_list: "emails.skipMailingList",
  no_reply_address: "emails.skipNoReplyAddress",
  no_analysis: "emails.skipNoAnalysis",
  likely_spam: "emails.skipLikelySpam",
  cooldown: "emails.skipCooldown",
  own_mail: "emails.skipOwnMail",
};

/**
 * `siblings` (the email's other executions) lets a move know whether it has
 * already been undone. Undo is offered only for a completed move that hasn't
 * been, and only with action_executions:undo; the backend checks all of it
 * again.
 */
export function ActionExecutionCard({ execution, siblings = [] }: { execution: ActionExecutionResponse; siblings?: ActionExecutionResponse[] }) {
  const t = useT();
  const retry = useRetryActionExecution(execution.id);
  const undo = useUndoActionExecution(execution.id);
  const mayUndo = useHasPermission("action_executions:undo") === true;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);

  const canRetry = execution.status === "failed" && execution.retryable === true;
  const details = execution.details ?? {};
  const undoneBy = siblings.find((s) => s.channelType === "archive_undo" && s.status === "succeeded" && s.details?.undoes === execution.id);
  const canUndo = mayUndo && execution.channelType === "archive" && execution.status === "succeeded" && typeof details.targetFolder === "string" && !undoneBy;
  const sourceFolder = typeof details.sourceFolder === "string" ? details.sourceFolder : null;
  const channelKey = CHANNEL_LABEL[execution.channelType];
  const skipKey = SKIP_REASON[String(details.skipped)];
  const bold = (c: string) => <b className="font-mono font-medium text-foreground">{c}</b>;

  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusBadge status={execution.status} />
          <Badge tone="neutral">{channelKey ? t(channelKey) : execution.channelType}</Badge>
          <span className="text-xs text-foreground-subtle">{t("emails.attempt", { n: execution.attemptNumber })}</span>
          {undoneBy ? <Badge tone="warning">{t("emails.undone")}</Badge> : null}
        </div>
        {canUndo ? (
          <Button variant="secondary" onClick={() => setConfirmUndo(true)} loading={undo.isPending}>
            {t("emails.undoMove")}
          </Button>
        ) : null}
        {canRetry ? (
          <Button variant="secondary" onClick={() => setConfirmOpen(true)} loading={retry.isPending}>
            {t("emails.retry")}
          </Button>
        ) : null}
      </div>

      {execution.channelType === "archive" && typeof details.targetFolder === "string" ? (
        <p className="mt-2 text-xs text-foreground-muted">
          {details.moved === false
            ? t("emails.alreadyGone")
            : t.rich("emails.movedFromTo", { b: bold }, { from: String(details.sourceFolder ?? "inbox"), to: details.targetFolder })}
        </p>
      ) : null}
      {execution.channelType === "archive_undo" && execution.status === "succeeded" ? (
        <p className="mt-2 text-xs text-foreground-muted">
          {t.rich("emails.movedBackFromTo", { b: bold }, { from: String(details.fromFolder ?? ""), to: String(details.toFolder ?? "") })}
        </p>
      ) : null}
      {execution.channelType === "auto_reply" && execution.status === "succeeded" ? (
        <p className="mt-2 text-xs text-foreground-muted">
          {details.sent === true
            ? t("emails.replySent")
            : t("emails.noReplySent", { reason: skipKey ? t(skipKey) : String(details.skipped ?? t("emails.skipped")) })}
        </p>
      ) : null}
      {(execution.channelType === "jira" || execution.channelType === "zendesk") && execution.status === "succeeded" && typeof details.url === "string" ? (
        <p className="mt-2 text-xs text-foreground-muted">
          {t.rich(
            "emails.openedTicket",
            {
              link: (c) => (
                <a href={details.url as string} target="_blank" rel="noreferrer" className="font-mono text-accent hover:underline">
                  {c}
                </a>
              ),
            },
            { reference: String(details.reference ?? details.url) },
          )}
        </p>
      ) : null}
      {execution.channelType === "flag" && execution.status === "succeeded" && details.applied === false ? (
        <p className="mt-2 text-xs text-foreground-muted">{t("emails.noFlagsSet")}</p>
      ) : null}

      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs text-foreground-muted sm:grid-cols-4">
        <div>
          <dt>{t("emails.started")}</dt>
          <dd className="text-foreground">{formatDateTime(execution.startedAt)}</dd>
        </div>
        <div>
          <dt>{t("emails.completed")}</dt>
          <dd className="text-foreground">{execution.completedAt ? formatDateTime(execution.completedAt) : "—"}</dd>
        </div>
        <div>
          <dt>{t("emails.retryable")}</dt>
          <dd className="text-foreground">{execution.retryable === null ? "—" : execution.retryable ? t("emails.yes") : t("emails.no")}</dd>
        </div>
        <div>
          <dt>{t("emails.errorClass")}</dt>
          <dd className="text-foreground">{execution.errorClass ?? "—"}</dd>
        </div>
      </dl>

      {execution.status === "ambiguous" ? (
        <p className="mt-2 rounded bg-status-warning-bg px-2 py-1.5 text-xs text-status-warning-fg">
          {t("emails.ambiguousNote")}
        </p>
      ) : null}

      {execution.errorMessage ? <p className="mt-2 text-xs text-status-danger-fg">{execution.errorMessage}</p> : null}

      {undo.data ? (
        <p className={`mt-2 text-xs ${undo.data.status === "succeeded" ? "text-status-success-fg" : undo.data.status === "ambiguous" ? "text-status-warning-fg" : "text-status-danger-fg"}`} role="status">
          {undo.data.message}
        </p>
      ) : null}
      {undo.isError ? (
        <p className="mt-2 text-xs text-status-danger-fg" role="alert">
          {undo.error instanceof ApiRequestError ? undo.error.message : t("emails.undoFailed")}
        </p>
      ) : null}

      {retry.isError ? (
        <p className="mt-2 text-xs text-status-danger-fg" role="alert">
          {retry.error instanceof ApiRequestError ? retry.error.message : t("emails.retryFailed")}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        title={t("emails.retryConfirmTitle")}
        description={t("emails.retryConfirmDescription")}
        confirmLabel={t("emails.retry")}
        confirmVariant="primary"
        loading={retry.isPending}
        onConfirm={() => {
          retry.mutate(undefined, { onSettled: () => setConfirmOpen(false) });
        }}
        onCancel={() => setConfirmOpen(false)}
      />

      <ConfirmDialog
        open={confirmUndo}
        title={t("emails.undoConfirmTitle")}
        description={t("emails.undoConfirmDescription", {
          from: String(details.targetFolder ?? ""),
          to: sourceFolder === null ? t("emails.originalFolder") : `"${sourceFolder}"`,
        })}
        confirmLabel={t("emails.moveBack")}
        confirmVariant="primary"
        loading={undo.isPending}
        onConfirm={() => {
          undo.mutate(undefined, { onSettled: () => setConfirmUndo(false) });
        }}
        onCancel={() => setConfirmUndo(false)}
      />
    </div>
  );
}
