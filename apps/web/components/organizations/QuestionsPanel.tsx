"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOrgPermissions } from "@/hooks/useAuth";
import {
  createQuestion,
  deleteQuestion,
  listQuestions,
  updateQuestion,
  type Question,
  type QuestionCriteria,
  type QuestionType,
} from "@/lib/api/questions";
import { ApiRequestError } from "@/lib/api/client";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { useT } from "@/lib/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";

const TYPE_LABELS: Record<QuestionType, MessageKey> = {
  noul: "organizations.questionTypeNoul",
  choice: "organizations.questionTypeChoice",
  score: "organizations.questionTypeScore",
};

const TYPE_HELP: Record<QuestionType, MessageKey> = {
  noul: "organizations.questionTypeNoulHelp",
  choice: "organizations.questionTypeChoiceHelp",
  score: "organizations.questionTypeScoreHelp",
};

const inputClass =
  "rounded-md border border-border-strong bg-surface-raised px-2.5 py-1.5 text-sm";
const KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
const MAX_INSTRUCTIONS = 1000;
const MAX_OPTIONS = 50;
const MIN_LEVELS = 2;
const MAX_LEVELS = 10;

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError ? error.message : fallback;
}

/** The rules named in a 409 "still in use" answer, or null for any other error. */
function usedByFrom(error: unknown): string[] | null {
  if (!(error instanceof ApiRequestError) || error.status !== 409) return null;
  const details = error.details as { usedBy?: unknown } | undefined;
  return Array.isArray(details?.usedBy)
    ? details.usedBy.filter((x): x is string => typeof x === "string")
    : [];
}

/** Editable form of the type-specific criteria; only the part for the question's type is used. */
interface CriteriaDraft {
  yes: string;
  no: string;
  options: Array<{ key: string; description: string }>;
  levels: string[];
}

function emptyDraft(): CriteriaDraft {
  return {
    yes: "",
    no: "",
    options: [
      { key: "", description: "" },
      { key: "", description: "" },
    ],
    levels: ["", ""],
  };
}

function draftFrom(question: Question): CriteriaDraft {
  const draft = emptyDraft();
  const c = question.criteria;
  if (question.type === "choice" && c && !Array.isArray(c)) {
    const entries = Object.entries(c as Record<string, string>);
    if (entries.length > 0)
      draft.options = entries.map(([key, description]) => ({ key, description }));
  } else if (question.type === "score" && Array.isArray(c)) {
    draft.levels = [...c];
  } else if (question.type === "noul" && c && !Array.isArray(c)) {
    const n = c as { true?: string; false?: string };
    draft.yes = n.true ?? "";
    draft.no = n.false ?? "";
  }
  return draft;
}

function criteriaFrom(
  type: QuestionType,
  draft: CriteriaDraft,
): QuestionCriteria | null {
  if (type === "choice")
    return Object.fromEntries(
      draft.options.map((o) => [o.key.trim(), o.description.trim()]),
    );
  if (type === "score") return draft.levels.map((l) => l.trim());
  const yes = draft.yes.trim();
  const no = draft.no.trim();
  if (!yes && !no) return null;
  return { ...(yes ? { true: yes } : {}), ...(no ? { false: no } : {}) };
}

/**
 * Phase 22: the organization's own questions for Jev. Each one is asked about
 * every new email alongside the built-in eight, and a rule can read the answer
 * as answers.<key>. Key and type are fixed once created; only the wording and
 * criteria can be edited.
 */
export function QuestionsPanel({ organizationId }: { organizationId: string }) {
  const t = useT();
  const permissions = useOrgPermissions(organizationId);
  const canRead = permissions.includes("rules:read");
  const canWrite = permissions.includes("rules:write");
  const questions = useQuery({
    queryKey: ["questions", organizationId],
    queryFn: ({ signal }) => listQuestions(organizationId, signal),
    enabled: canRead,
  });

  if (!canRead)
    return (
      <p className="text-sm text-foreground-muted">
        {t("organizations.questionsNeedRead")}
      </p>
    );

  const rows = questions.data?.data ?? [];
  const limit = questions.data?.limit ?? 20;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-2 text-sm text-foreground-muted">
        <p>
          {t.rich("organizations.questionsIntro", {
            code: (c) => <code className="font-mono text-xs">{c}</code>,
          })}
        </p>
        <p>{t("organizations.questionsCostNote")}</p>
        <p>{t("organizations.questionsPastEmailsNote")}</p>
      </div>

      {questions.isPending ? (
        <LoadingState label={t("organizations.questionsLoading")} />
      ) : questions.isError ? (
        <ErrorState error={questions.error} onRetry={() => questions.refetch()} />
      ) : (
        <>
          <p className="text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
            {t("organizations.questionsCount", { n: rows.length, limit })}
          </p>
          {rows.length === 0 ? (
            <p className="text-sm text-foreground-subtle">
              {t("organizations.questionsEmpty")}
            </p>
          ) : (
            <ul className="divide-y divide-border border border-border">
              {rows.map((q) => (
                <QuestionRow
                  key={`${q.id}-${q.updatedAt}`}
                  organizationId={organizationId}
                  question={q}
                  canWrite={canWrite}
                />
              ))}
            </ul>
          )}
          {!canWrite ? (
            <p className="text-xs text-foreground-subtle">
              {t("organizations.questionsNeedWrite")}
            </p>
          ) : rows.length >= limit ? (
            <p className="text-sm text-status-warning-fg">
              {t("organizations.questionsLimitReached", { limit })}
            </p>
          ) : (
            <CreateQuestionForm organizationId={organizationId} />
          )}
        </>
      )}
    </div>
  );
}

function CriteriaSummary({ question }: { question: Question }) {
  const t = useT();
  const c = question.criteria;
  if (question.type === "choice" && c && !Array.isArray(c)) {
    return (
      <ul className="space-y-0.5 text-xs text-foreground-muted">
        {Object.entries(c as Record<string, string>).map(([option, text]) => (
          <li key={option}>
            <span className="font-mono text-foreground">{option}</span> — {text}
          </li>
        ))}
      </ul>
    );
  }
  if (question.type === "score" && Array.isArray(c)) {
    return (
      <p className="text-xs text-foreground-muted">
        {t("organizations.questionLevelsSummary")}{" "}
        <span className="text-foreground">{c.join(" < ")}</span>
      </p>
    );
  }
  if (question.type === "noul" && c && !Array.isArray(c)) {
    const n = c as { true?: string; false?: string };
    return (
      <div className="space-y-0.5 text-xs text-foreground-muted">
        {n.true ? (
          <p>{t("organizations.questionYesMeansSummary", { text: n.true })}</p>
        ) : null}
        {n.false ? (
          <p>{t("organizations.questionNoMeansSummary", { text: n.false })}</p>
        ) : null}
      </div>
    );
  }
  return null;
}

function QuestionRow({
  organizationId,
  question,
  canWrite,
}: {
  organizationId: string;
  question: Question;
  canWrite: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [instructions, setInstructions] = useState(question.instructions);
  const [draft, setDraft] = useState<CriteriaDraft>(() => draftFrom(question));
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["questions", organizationId] });

  const update = useMutation({
    mutationFn: () =>
      updateQuestion(organizationId, question.id, {
        instructions: instructions.trim(),
        criteria: criteriaFrom(question.type, draft),
      }),
    onSuccess: () => {
      setEditing(false);
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (force: boolean) =>
      deleteQuestion(organizationId, question.id, force),
    onSuccess: () => void refresh(),
  });
  const blockedBy = remove.isError ? usedByFrom(remove.error) : null;
  const usedBy = question.usedBy ?? [];

  return (
    <li className="space-y-2 px-3 py-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-mono font-medium text-foreground">
              {question.field}
            </span>
            <Badge tone="info" variant="pill">
              {t(TYPE_LABELS[question.type])}
            </Badge>
          </p>
          {!editing ? (
            <p className="whitespace-pre-wrap text-foreground">
              {question.instructions}
            </p>
          ) : null}
        </div>
        {canWrite && !editing ? (
          <div className="flex shrink-0 gap-2">
            <Button variant="secondary" onClick={() => setEditing(true)}>
              {t("organizations.questionEdit")}
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => {
                remove.reset();
                setConfirm(true);
              }}
            >
              {t("organizations.questionDelete")}
            </Button>
          </div>
        ) : null}
      </div>

      {editing ? (
        <div className="space-y-3 border border-border p-3">
          <p className="text-[11px] text-foreground-subtle">
            {t("organizations.questionEditHint")}
          </p>
          <InstructionsField value={instructions} onChange={setInstructions} />
          <CriteriaEditor type={question.type} draft={draft} onChange={setDraft} />
          {update.isError ? (
            <p className="text-sm text-status-danger-fg" role="alert">
              {errorText(update.error, t("common.saveFailed"))}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              variant="primary"
              loading={update.isPending}
              disabled={!instructions.trim()}
              onClick={() => update.mutate()}
            >
              {t("common.save")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setEditing(false);
                setInstructions(question.instructions);
                setDraft(draftFrom(question));
                update.reset();
              }}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <CriteriaSummary question={question} />
      )}

      <p className="text-xs text-foreground-subtle">
        {usedBy.length > 0
          ? t("organizations.questionUsedBy", { names: usedBy.join(", ") })
          : t("organizations.questionUsedByNone")}
      </p>

      {blockedBy ? (
        <div
          className="space-y-2 border border-status-warning-fg/30 bg-status-warning-bg p-3"
          role="alert"
        >
          <p className="text-sm text-foreground">
            {t("organizations.questionInUse")}
          </p>
          <ul className="list-disc pl-5 text-xs text-foreground">
            {blockedBy.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
          <p className="text-xs text-foreground-muted">
            {t("organizations.questionDeleteAnywayHelp")}
          </p>
          <div className="flex gap-2">
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => remove.mutate(true)}
            >
              {t("organizations.questionDeleteAnyway")}
            </Button>
            <Button variant="secondary" onClick={() => remove.reset()}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : remove.isError ? (
        <p className="text-sm text-status-danger-fg" role="alert">
          {errorText(remove.error, t("organizations.questionDeleteFailed"))}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirm}
        title={t("organizations.questionDeleteTitle", { key: question.key })}
        description={t("organizations.questionDeleteDescription")}
        confirmLabel={t("organizations.questionDelete")}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          remove.mutate(false);
        }}
      />
    </li>
  );
}

function InstructionsField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  return (
    <label className="block text-xs text-foreground-muted">
      {t("organizations.questionTextLabel")}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={MAX_INSTRUCTIONS}
        aria-label={t("organizations.questionTextLabel")}
        rows={3}
        placeholder={t("organizations.questionTextPlaceholder")}
        className={`${inputClass} mt-1 block w-full`}
      />
      <span className="mt-0.5 block text-right text-[10px] text-foreground-subtle">
        {value.length} / {MAX_INSTRUCTIONS}
      </span>
    </label>
  );
}

function CriteriaEditor({
  type,
  draft,
  onChange,
}: {
  type: QuestionType;
  draft: CriteriaDraft;
  onChange: (draft: CriteriaDraft) => void;
}) {
  const t = useT();

  if (type === "noul") {
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs text-foreground-muted">
          {t("organizations.questionYesMeans")}
          <input
            value={draft.yes}
            maxLength={300}
            onChange={(e) => onChange({ ...draft, yes: e.target.value })}
            placeholder={t("organizations.questionOptional")}
            className={`${inputClass} mt-1 block w-full`}
          />
        </label>
        <label className="block text-xs text-foreground-muted">
          {t("organizations.questionNoMeans")}
          <input
            value={draft.no}
            maxLength={300}
            onChange={(e) => onChange({ ...draft, no: e.target.value })}
            placeholder={t("organizations.questionOptional")}
            className={`${inputClass} mt-1 block w-full`}
          />
        </label>
      </div>
    );
  }

  if (type === "choice") {
    const setOption = (
      index: number,
      patch: Partial<{ key: string; description: string }>,
    ) =>
      onChange({
        ...draft,
        options: draft.options.map((o, i) =>
          i === index ? { ...o, ...patch } : o,
        ),
      });
    return (
      <fieldset className="space-y-2">
        <legend className="text-xs text-foreground-muted">
          {t("organizations.questionOptionsLegend")}
        </legend>
        <p className="text-[11px] text-foreground-subtle">
          {t("organizations.questionOptionsHint", { max: MAX_OPTIONS })}
        </p>
        {draft.options.map((option, index) => {
          const badKey = option.key !== "" && !KEY_PATTERN.test(option.key);
          return (
            <div key={index} className="flex flex-wrap items-start gap-2">
              <input
                value={option.key}
                maxLength={40}
                onChange={(e) => setOption(index, { key: e.target.value })}
                placeholder={t("organizations.questionOptionKeyPlaceholder")}
                aria-label={t("organizations.questionOptionKeyAria", {
                  n: index + 1,
                })}
                aria-invalid={badKey || undefined}
                className={`${inputClass} w-44 font-mono ${badKey ? "border-status-danger-fg" : ""}`}
              />
              <input
                value={option.description}
                maxLength={300}
                onChange={(e) =>
                  setOption(index, { description: e.target.value })
                }
                placeholder={t(
                  "organizations.questionOptionDescriptionPlaceholder",
                )}
                aria-label={t("organizations.questionOptionDescriptionAria", {
                  n: index + 1,
                })}
                className={`${inputClass} min-w-48 flex-1`}
              />
              <Button
                type="button"
                variant="ghost"
                disabled={draft.options.length <= 2}
                aria-label={t("organizations.questionRemoveOptionAria", {
                  n: index + 1,
                })}
                onClick={() =>
                  onChange({
                    ...draft,
                    options: draft.options.filter((_, i) => i !== index),
                  })
                }
              >
                ×
              </Button>
            </div>
          );
        })}
        <Button
          type="button"
          variant="secondary"
          disabled={draft.options.length >= MAX_OPTIONS}
          onClick={() =>
            onChange({
              ...draft,
              options: [...draft.options, { key: "", description: "" }],
            })
          }
        >
          {t("organizations.questionAddOption")}
        </Button>
      </fieldset>
    );
  }

  return (
    <fieldset className="space-y-2">
      <legend className="text-xs text-foreground-muted">
        {t("organizations.questionLevelsLegend")}
      </legend>
      <p className="text-[11px] text-foreground-subtle">
        {t("organizations.questionLevelsHint", {
          min: MIN_LEVELS,
          max: MAX_LEVELS,
        })}
      </p>
      <ol className="space-y-2">
        {draft.levels.map((level, index) => (
          <li key={index} className="flex items-center gap-2">
            <span className="w-5 text-right font-mono text-xs text-foreground-subtle">
              {index + 1}.
            </span>
            <input
              value={level}
              maxLength={100}
              onChange={(e) =>
                onChange({
                  ...draft,
                  levels: draft.levels.map((l, i) =>
                    i === index ? e.target.value : l,
                  ),
                })
              }
              aria-label={t("organizations.questionLevelAria", {
                n: index + 1,
              })}
              className={`${inputClass} min-w-48 flex-1`}
            />
            <Button
              type="button"
              variant="ghost"
              disabled={draft.levels.length <= MIN_LEVELS}
              aria-label={t("organizations.questionRemoveLevelAria", {
                n: index + 1,
              })}
              onClick={() =>
                onChange({
                  ...draft,
                  levels: draft.levels.filter((_, i) => i !== index),
                })
              }
            >
              ×
            </Button>
          </li>
        ))}
      </ol>
      <Button
        type="button"
        variant="secondary"
        disabled={draft.levels.length >= MAX_LEVELS}
        onClick={() => onChange({ ...draft, levels: [...draft.levels, ""] })}
      >
        {t("organizations.questionAddLevel")}
      </Button>
    </fieldset>
  );
}

function CreateQuestionForm({ organizationId }: { organizationId: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [key, setKey] = useState("");
  const [type, setType] = useState<QuestionType>("noul");
  const [instructions, setInstructions] = useState("");
  const [draft, setDraft] = useState<CriteriaDraft>(emptyDraft);
  const create = useMutation({
    mutationFn: () => {
      const criteria = criteriaFrom(type, draft);
      return createQuestion(organizationId, {
        key: key.trim(),
        type,
        instructions: instructions.trim(),
        ...(criteria ? { criteria } : {}),
      });
    },
    onSuccess: () => {
      setKey("");
      setInstructions("");
      setDraft(emptyDraft());
      void queryClient.invalidateQueries({
        queryKey: ["questions", organizationId],
      });
    },
  });
  const badKey = key.trim() !== "" && !KEY_PATTERN.test(key.trim());

  return (
    <form
      className="space-y-3 border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <p className="text-[10px] font-semibold tracking-wide text-foreground-subtle uppercase">
        {t("organizations.questionNew")}
      </p>
      <div className="flex flex-wrap gap-3">
        <label className="block text-xs text-foreground-muted">
          {t("organizations.questionKeyLabel")}
          <span className="mt-1 flex items-center gap-1">
            <span className="font-mono text-xs text-foreground-subtle">
              answers.
            </span>
            <input
              value={key}
              maxLength={40}
              onChange={(e) => setKey(e.target.value)}
              placeholder="needs_invoice"
              aria-label={t("organizations.questionKeyLabel")}
              aria-invalid={badKey || undefined}
              className={`${inputClass} w-52 font-mono ${badKey ? "border-status-danger-fg" : ""}`}
            />
          </span>
        </label>
        <label className="block text-xs text-foreground-muted">
          {t("organizations.questionTypeLabel")}
          <select
            value={type}
            onChange={(e) => setType(e.target.value as QuestionType)}
            aria-label={t("organizations.questionTypeLabel")}
            className={`${inputClass} mt-1 block`}
          >
            {(Object.keys(TYPE_LABELS) as QuestionType[]).map((value) => (
              <option key={value} value={value}>
                {t(TYPE_LABELS[value])}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="-mt-1 text-[11px] text-foreground-subtle">
        {t("organizations.questionKeyHint")}
      </p>
      <p className="text-[11px] text-foreground-subtle">{t(TYPE_HELP[type])}</p>

      <InstructionsField value={instructions} onChange={setInstructions} />
      <CriteriaEditor type={type} draft={draft} onChange={setDraft} />

      <div className="space-y-1 border-l-2 border-accent/40 pl-3 text-[11px] text-foreground-muted">
        <p className="font-semibold text-foreground">
          {t("organizations.questionTipsTitle")}
        </p>
        <p>{t("organizations.questionTipOneThing")}</p>
        <p>{t("organizations.questionTipYesHigh")}</p>
      </div>

      {create.isError ? (
        <p className="text-sm text-status-danger-fg" role="alert">
          {errorText(create.error, t("organizations.questionCreateFailed"))}
        </p>
      ) : null}
      <Button
        type="submit"
        variant="primary"
        disabled={!key.trim() || !instructions.trim()}
        loading={create.isPending}
      >
        {t("organizations.questionCreate")}
      </Button>
    </form>
  );
}
