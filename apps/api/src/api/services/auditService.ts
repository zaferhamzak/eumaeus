import type { Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { assertEmailExists } from "./emailService.js";
import { paginateByCursor, type CursorPage, type PaginationQuery } from "../pagination.js";
import { serializeAuditEvent, type AuditEventResponse } from "../serializers/auditEventSerializer.js";

export interface ListAuditQuery extends PaginationQuery {
  eventType?: string;
  emailId?: string;
  createdAfter?: Date;
  createdBefore?: Date;
}

/** Read-only (§16): no function in this file, or anywhere under api/, ever calls auditEvent.create/update/delete — recordAuditEvent (modules/audit/record.ts) remains the sole write path. */
export async function listAuditEvents(tenantId: string, query: ListAuditQuery): Promise<CursorPage<AuditEventResponse>> {
  const where: Prisma.AuditEventWhereInput = { tenantId };
  if (query.eventType) where.eventType = query.eventType;
  if (query.emailId) where.emailId = query.emailId;
  if (query.createdAfter || query.createdBefore) {
    where.createdAt = {
      ...(query.createdAfter ? { gte: query.createdAfter } : {}),
      ...(query.createdBefore ? { lte: query.createdBefore } : {}),
    };
  }

  const page = await paginateByCursor(query, ({ cursorId, take }) =>
    prisma.auditEvent.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take,
    }),
  );
  return { ...page, data: page.data.map(serializeAuditEvent) };
}

export async function listAuditEventsForEmail(
  tenantId: string,
  emailId: string,
  query: PaginationQuery,
): Promise<CursorPage<AuditEventResponse>> {
  await assertEmailExists(tenantId, emailId);
  const page = await paginateByCursor(query, ({ cursorId, take }) =>
    prisma.auditEvent.findMany({
      where: { tenantId, emailId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take,
    }),
  );
  return { ...page, data: page.data.map(serializeAuditEvent) };
}
