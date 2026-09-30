"use client";

import { useState } from "react";
import { useAddReviewNote, useAssignReview, useReviewAssignees } from "@/hooks/useReviews";
import { useMe } from "@/hooks/useAuth";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ApiRequestError } from "@/lib/api/client";
import { formatRelativeTime } from "@/lib/format";
import { useT } from "@/lib/i18n/I18nProvider";
import type { ReviewDetailResponse } from "@/types/api";

const MAX_NOTE = 2000;

/**
 * Phase 28: who is on this item, and what the team said about it. Anyone who
 * can read sees the assignee and notes; assigning and writing notes need
 * reviews:resolve. Both land in the audit log.
 */
export function ReviewTeamworkCard({ review, canResolve }: { review: ReviewDetailResponse; canResolve: boolean }) {
  const t = useT();
  const me = useMe();
  const assignees = useReviewAssignees(canResolve);
  const assign = useAssignReview(review.id);
  const addNote = useAddReviewNote(review.id);
  const [draft, setDraft] = useState("");
  const notes = review.notes ?? [];
  const myId = me.data?.user.id;
  const assigneeLabel = review.assignedTo ? (review.assignedToEmail ?? t("review.assigneeUnknown")) : t("review.unassigned");
  const error = assign.error ?? addNote.error;

  return (
    <Card>
      <CardHeader title={t("review.teamTitle")} />
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-foreground-muted">{t("review.assigneeLabel")}</span>
          {canResolve ? (
            <>
              <label className="sr-only" htmlFor="review-assignee">
                {t("review.assigneeLabel")}
              </label>
              <select
                id="review-assignee"
                value={review.assignedTo ?? ""}
                disabled={assign.isPending || assignees.isPending}
                onChange={(e) => assign.mutate(e.target.value || null)}
                className="h-7 border border-border bg-surface px-1 text-xs text-foreground rounded-md"
              >
                <option value="">{t("review.unassigned")}</option>
                {review.assignedTo && !(assignees.data?.data ?? []).some((a) => a.userId === review.assignedTo) ? <option value={review.assignedTo}>{assigneeLabel}</option> : null}
                {(assignees.data?.data ?? []).map((a) => (
                  <option key={a.userId} value={a.userId}>
                    {a.userId === myId ? t("review.assigneeMe", { email: a.email }) : a.email}
                  </option>
                ))}
              </select>
              {myId && review.assignedTo !== myId && (assignees.data?.data ?? []).some((a) => a.userId === myId) ? (
                <Button variant="ghost" className="h-7 px-2 text-xs rounded-md" disabled={assign.isPending} onClick={() => assign.mutate(myId)}>
                  {t("review.assignToMe")}
                </Button>
              ) : null}
            </>
          ) : (
            <span className="font-medium text-foreground">{assigneeLabel}</span>
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-foreground-muted">{t("review.notesTitle")}</h3>
          {notes.length === 0 ? (
            <p className="text-xs text-foreground-subtle">{t("review.notesEmpty")}</p>
          ) : (
            <ul className="space-y-2">
              {notes.map((n) => (
                <li key={n.id} className="border-l-2 border-border pl-2">
                  <p className="whitespace-pre-wrap break-words text-sm text-foreground">{n.text}</p>
                  <p className="text-[11px] text-foreground-subtle">
                    {n.author} · {formatRelativeTime(n.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {canResolve ? (
            <form
              className="space-y-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (!draft.trim()) return;
                addNote.mutate(draft.trim(), { onSuccess: () => setDraft("") });
              }}
            >
              <label className="sr-only" htmlFor="review-note">
                {t("review.noteLabel")}
              </label>
              <textarea
                id="review-note"
                value={draft}
                maxLength={MAX_NOTE}
                rows={2}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t("review.notePlaceholder")}
                className="w-full border border-border bg-surface px-2 py-1 text-sm text-foreground placeholder:text-foreground-subtle"
              />
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] text-foreground-subtle">{t("review.noteAuditHint")}</p>
                <Button type="submit" variant="secondary" className="h-7 px-2 text-xs rounded-md" disabled={addNote.isPending || !draft.trim()}>
                  {t("review.addNote")}
                </Button>
              </div>
            </form>
          ) : null}
        </div>

        {error ? (
          <p className="text-xs text-status-danger-fg" role="alert">
            {error instanceof ApiRequestError ? error.message : t("review.teamFailed")}
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
