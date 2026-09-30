import { apiRequest } from "./client";
import type { ActionExecutionResponse, CursorPage } from "@/types/api";

export function listActionExecutions(
  params: { limit?: number; cursor?: string; status?: string } = {},
  signal?: AbortSignal,
) {
  return apiRequest<CursorPage<ActionExecutionResponse>>(
    "/api/v1/action-executions",
    { query: params, signal },
  );
}

export function getActionExecution(id: string, signal?: AbortSignal) {
  return apiRequest<ActionExecutionResponse>(
    `/api/v1/action-executions/${id}`,
    { signal },
  );
}

/**
 * Calls the backend's own retry endpoint exactly — no client-side retry
 * mechanism exists or should ever be added here (§13). The backend rejects
 * this with 409/INVALID_STATE for anything not genuinely
 * status="failed" && retryable=true; the UI's job is to reflect that
 * (components/email/ActionExecutionCard.tsx only shows the button when the
 * fetched state already satisfies it), never to second-guess it.
 */
/** Phase 15: moves an archived message back to its original folder. Runs immediately; the result says whether it worked. */
export function undoActionExecution(id: string) {
  return apiRequest<{
    status: "succeeded" | "failed" | "ambiguous";
    message: string;
    execution: ActionExecutionResponse;
  }>(`/api/v1/action-executions/${id}/undo`, {
    method: "POST",
  });
}

export function retryActionExecution(id: string) {
  return apiRequest<ActionExecutionResponse>(
    `/api/v1/action-executions/${id}/retry`,
    { method: "POST" },
  );
}
