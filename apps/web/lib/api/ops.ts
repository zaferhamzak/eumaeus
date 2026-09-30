import { apiRequest } from "./client";
import type {
  AlertResponse,
  HostReportResponse,
  ReportResponse,
  RoutingDecisionResponse,
} from "@/types/api";

export function listAlerts(
  status: "open" | "resolved" = "open",
  signal?: AbortSignal,
) {
  return apiRequest<{ data: AlertResponse[] }>("/api/v1/alerts", {
    query: { status },
    signal,
  });
}

export function getReport(
  params: { days: 7 | 30 | 90; tz: string; mailboxId?: string },
  signal?: AbortSignal,
) {
  return apiRequest<ReportResponse>("/api/v1/stats/reports", {
    query: params,
    signal,
  });
}

/** Closes an open alert for everyone; it stays closed while the problem lasts. */
export function dismissAlert(id: string) {
  return apiRequest<AlertResponse>(`/api/v1/alerts/${id}/dismiss`, { method: "POST" });
}

/** Host view: every organization at once (superAdmin only). */
export function getHostReport(
  params: { days: 7 | 30 | 90; tz: string },
  signal?: AbortSignal,
) {
  return apiRequest<HostReportResponse>("/api/v1/admin/reports", {
    query: params,
    signal,
  });
}

/**
 * Phase 18: re-routes the email with the current rules and runs the new
 * decision's actions. Phase 22: `reanalyze` asks Jev again first (a Jev call;
 * picks up the organization's current custom questions) — refused by the API
 * when the email's content was removed by retention.
 */
export function reprocessEmail(emailId: string, options: { reanalyze?: boolean } = {}) {
  return apiRequest<{
    emailId: string;
    previousDecisionId: string | null;
    decision: RoutingDecisionResponse;
  }>(`/api/v1/emails/${emailId}/reprocess`, {
    method: "POST",
    body: { reanalyze: options.reanalyze ?? false },
  });
}

/** Phase 26: one job queue's counts and its latest failures (superAdmin only). */
export interface QueueHealthResponse {
  name: string;
  counts: { waiting: number; active: number; delayed: number; failed: number; completed: number };
  recentFailures: Array<{ id: string; name: string; failedAt: string | null; reason: string; attempts: number; mailboxConnectionId?: string }>;
}

export interface MailboxHealthResponse {
  id: string;
  name: string | null;
  emailAddress: string;
  status: string;
  lastSyncSuccessAt: string | null;
  lastSyncFailureAt: string | null;
  lastSyncError: string | null;
  consecutiveFailures: number;
  health: "ok" | "failing" | "never_synced" | "needs_sign_in" | "disabled";
  /** 1.1: the worker holds an open IDLE connection — new mail within seconds. */
  live: boolean;
}

export function getQueueHealth(signal?: AbortSignal) {
  return apiRequest<{ data: QueueHealthResponse[] }>("/api/v1/admin/queues", { signal });
}

/** The current organization's mailboxes, problems first. */
export function getMailboxHealth(signal?: AbortSignal) {
  return apiRequest<{ data: MailboxHealthResponse[] }>("/api/v1/mailboxes/health", { signal });
}

/** 1.2 (G): is Jev working for this organization, and what is waiting on it. */
export interface JevStatusResponse {
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  currentError: { httpStatus: number | null; message: string } | null;
  accessDenied: boolean;
  waiting: number;
  failed: number;
  failedEmailIds: string[];
  last7Days: { ok: number; error: number; inputTokens: number };
}

export function getJevStatus(signal?: AbortSignal) {
  return apiRequest<JevStatusResponse>("/api/v1/jev/status", { signal });
}

/** Up to 100 emails at once; `reanalyze` asks Jev again first (billed). */
export function reprocessEmails(emailIds: string[], options: { reanalyze?: boolean } = {}) {
  return apiRequest<{ results: Array<{ emailId: string; status: "reprocessed" | "refused"; reason?: string; message?: string }> }>("/api/v1/emails/reprocess", {
    method: "POST",
    body: { emailIds, reanalyze: options.reanalyze ?? false },
  });
}
