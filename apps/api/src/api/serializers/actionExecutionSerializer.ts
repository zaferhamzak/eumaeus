import type { ActionExecution } from "@prisma/client";

export interface ActionExecutionResponse {
  id: string;
  tenantId: string;
  emailId: string;
  routingDecisionId: string;
  destinationChannelId: string;
  channelType: string;
  channelVersion: number;
  idempotencyKey: string;
  attemptNumber: number;
  status: string;
  retryable: boolean | null;
  errorClass: string | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  /**
   * Phase 15: a small, per-type WHITELIST of non-sensitive facts the UI needs
   * (which folders a move involved, which move an undo reverses). null for
   * types that expose nothing.
   */
  details: Record<string, unknown> | null;
}

/**
 * Deliberately omits requestMetadata/responseMetadata (§14 only asks for the
 * fields below) — those columns hold non-sensitive summaries today (verified in
 * the Phase 5A/5B adversarial audits: e.g. archive's {moved, targetFolder},
 * webhook's {statusCode}), but this serializer's whitelist doesn't rely on that
 * staying true forever. errorMessage may include a raw transport error string
 * (e.g. "ECONNREFUSED") — an operator-useful diagnostic, never a header,
 * Authorization value, or secret; nothing in this codebase ever constructs one
 * from a secret (see webhookExecutor.ts/archiveExecutor.ts).
 */
export function serializeActionExecution(row: ActionExecution): ActionExecutionResponse {
  return {
    id: row.id,
    tenantId: row.tenantId,
    emailId: row.emailId,
    routingDecisionId: row.routingDecisionId,
    destinationChannelId: row.destinationChannelId,
    channelType: row.channelType,
    channelVersion: row.channelVersion,
    idempotencyKey: row.idempotencyKey,
    attemptNumber: row.attemptNumber,
    status: row.status,
    retryable: row.retryable,
    errorClass: row.errorClass,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    details: detailsFor(row),
  };
}

function detailsFor(row: ActionExecution): Record<string, unknown> | null {
  const response = (row.responseMetadata ?? {}) as Record<string, unknown>;
  const request = (row.requestMetadata ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  if (row.channelType === "archive") {
    return { moved: response.moved === true, targetFolder: str(response.targetFolder), sourceFolder: str(response.sourceFolder) };
  }
  if (row.channelType === "archive_undo") {
    return { undoes: str(request.undoes), fromFolder: str(request.fromFolder), toFolder: str(request.toFolder) };
  }
  if (row.channelType === "flag") {
    return { applied: response.applied === true };
  }
  if (row.channelType === "auto_reply") {
    return { sent: response.sent === true, skipped: str(response.skipped), detail: str(response.detail) };
  }
  if (row.channelType === "jira" || row.channelType === "zendesk") {
    return { reference: str(response.issueKey) ?? (typeof response.ticketId === "number" ? `#${response.ticketId}` : null), url: str(response.url) };
  }
  return null;
}
