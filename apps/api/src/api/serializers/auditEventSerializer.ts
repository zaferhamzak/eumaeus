import type { AuditEvent } from "@prisma/client";

export interface AuditEventResponse {
  id: string;
  tenantId: string;
  emailId: string | null;
  eventType: string;
  payload: unknown;
  actor: string;
  createdAt: string;
}

/** Read-only by construction: this file has no function that writes an AuditEvent — recordAuditEvent (modules/audit/record.ts) remains the only write path, preserving append-only semantics (§16). */
export function serializeAuditEvent(row: AuditEvent): AuditEventResponse {
  return {
    id: row.id,
    tenantId: row.tenantId,
    emailId: row.emailId,
    eventType: row.eventType,
    payload: row.payload,
    actor: row.actor,
    createdAt: row.createdAt.toISOString(),
  };
}
