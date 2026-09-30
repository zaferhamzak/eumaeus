import { prisma } from "../../db/client.js";

/**
 * Phase 20: the audit log as CSV, for a date range. Streamed in batches
 * (keyset pagination on createdAt, id) so a year of events never sits in
 * memory. Oldest first, which is how auditors read a log.
 *
 * Cells are quoted per RFC 4180. A cell that a spreadsheet would treat as a
 * formula (starts with = + - @, tab or carriage return) is prefixed with a
 * single quote — audit payloads carry email subjects and addresses, which
 * are attacker-controlled text.
 */
export const AUDIT_CSV_COLUMNS = ["created_at", "event_type", "actor", "email_id", "payload"] as const;
export const MAX_EXPORT_DAYS = 366;
const BATCH = 1000;

export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export interface AuditExportFilter {
  tenantId: string;
  from: Date;
  to: Date;
  eventType?: string;
}

export async function* auditCsvLines(filter: AuditExportFilter): AsyncGenerator<string> {
  yield `﻿${AUDIT_CSV_COLUMNS.join(",")}\r\n`; // BOM so Excel reads UTF-8 (Turkish characters) correctly
  let after: { createdAt: Date; id: string } | null = null;
  for (;;) {
    const rows: Array<{ id: string; createdAt: Date; eventType: string; actor: string; emailId: string | null; payload: unknown }> = await prisma.auditEvent.findMany({
      where: {
        tenantId: filter.tenantId,
        createdAt: { gte: filter.from, lt: filter.to },
        ...(filter.eventType ? { eventType: filter.eventType } : {}),
        ...(after ? { OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] } : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: BATCH,
      select: { id: true, createdAt: true, eventType: true, actor: true, emailId: true, payload: true },
    });
    if (rows.length === 0) return;
    yield rows.map((r) => [r.createdAt.toISOString(), r.eventType, r.actor, r.emailId, r.payload].map(csvCell).join(",") + "\r\n").join("");
    if (rows.length < BATCH) return;
    const last = rows[rows.length - 1]!;
    after = { createdAt: last.createdAt, id: last.id };
  }
}
