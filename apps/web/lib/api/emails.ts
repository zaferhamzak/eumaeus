import { apiRequest } from "./client";
import type { RuleImpact, RuleInput } from "./rules";
import type {
  AnalysisResultResponse,
  CursorPage,
  EmailDetailResponse,
  EmailSummaryResponse,
  ActionExecutionResponse,
  AuditEventResponse,
  RoutingDecisionResponse,
} from "@/types/api";

export interface ListEmailsParams {
  limit?: number;
  cursor?: string;
  state?: string;
  mailboxConnectionId?: string;
  sender?: string;
  subject?: string;
  /** Phase 28: any To address containing this text. */
  recipient?: string;
  /** Phase 28: a destination name, "human_review" or "left_alone". */
  destination?: string;
  receivedAfter?: string;
  receivedBefore?: string;
}

export function listEmails(
  params: ListEmailsParams = {},
  signal?: AbortSignal,
) {
  return apiRequest<CursorPage<EmailSummaryResponse>>("/api/v1/emails", {
    query: params,
    signal,
  });
}

export function getEmail(
  id: string,
  includeBody = false,
  signal?: AbortSignal,
) {
  return apiRequest<EmailDetailResponse>(`/api/v1/emails/${id}`, {
    query: { includeBody: includeBody || undefined },
    signal,
  });
}

export function getEmailAnalysis(id: string, signal?: AbortSignal) {
  return apiRequest<AnalysisResultResponse>(`/api/v1/emails/${id}/analysis`, {
    signal,
  });
}

export function getEmailRouting(id: string, signal?: AbortSignal) {
  return apiRequest<RoutingDecisionResponse>(`/api/v1/emails/${id}/routing`, {
    signal,
  });
}

export function listEmailExecutions(
  id: string,
  params: { limit?: number; cursor?: string } = {},
  signal?: AbortSignal,
) {
  return apiRequest<CursorPage<ActionExecutionResponse>>(
    `/api/v1/emails/${id}/executions`,
    { query: params, signal },
  );
}

export function listEmailAudit(
  id: string,
  params: { limit?: number; cursor?: string } = {},
  signal?: AbortSignal,
) {
  return apiRequest<CursorPage<AuditEventResponse>>(
    `/api/v1/emails/${id}/audit`,
    { query: params, signal },
  );
}

/** Phase 24: the result of putting an email where it belongs. */
export interface CorrectEmailResult {
  /** Where the replaced decision had sent it (a destination name, "human_review", "left_alone"), or null. */
  previousDestination: string | null;
  /** Whether the email was moved back in the mailbox first. */
  movedBack: boolean;
  decision: RoutingDecisionResponse;
}

/** Phase 24: "this email belongs somewhere else" — a destination name, or "inbox" to bring it back and leave it. */
export function correctEmail(id: string, destinationRef: string) {
  return apiRequest<CorrectEmailResult>(`/api/v1/emails/${id}/correct`, {
    method: "POST",
    body: { destinationRef },
  });
}

export interface CorrectionRuleDraft {
  rule: RuleInput;
  /** Other recent emails from the sender, sharing the subject word, that went to the same wrong place. */
  alsoWrong: number;
  word: string | null;
  impact: RuleImpact;
}

/** Phase 24: a draft rule that would have sent this email to `destinationRef` (read-only; nothing is saved). */
export function getCorrectionRule(
  id: string,
  params: { destinationRef: string; wrong?: string | null },
  signal?: AbortSignal,
) {
  return apiRequest<CorrectionRuleDraft>(`/api/v1/emails/${id}/correction-rule`, {
    query: { destinationRef: params.destinationRef, wrong: params.wrong ?? undefined },
    signal,
  });
}

export const MAX_EMAILS_PER_DELETE = 100;

/** Permanently deletes Eumaeus's copy of the selected emails (privacy:erase). The messages in the mailbox are not touched. */
export function deleteEmails(emailIds: string[]) {
  return apiRequest<{ deleted: number }>("/api/v1/emails/delete", { method: "POST", body: { emailIds } });
}
