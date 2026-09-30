import { apiDownload, apiRequest } from "./client";
import type { AuditEventResponse, CursorPage } from "@/types/api";

export interface ListAuditParams {
  limit?: number;
  cursor?: string;
  eventType?: string;
  emailId?: string;
  createdAfter?: string;
  createdBefore?: string;
}

export function listAudit(params: ListAuditParams = {}, signal?: AbortSignal) {
  return apiRequest<CursorPage<AuditEventResponse>>("/api/v1/audit", {
    query: params,
    signal,
  });
}

/** Phase 20: downloads the audit log for [from, to) as CSV. */
export function downloadAuditCsv(params: {
  from: string;
  to: string;
  eventType?: string;
}) {
  return apiDownload("/api/v1/audit/export.csv", {
    query: params,
    fallbackName: "eumaeus-audit.csv",
  });
}
