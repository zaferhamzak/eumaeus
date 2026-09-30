import type { Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { NotFoundError } from "../errors/ApiError.js";
import { MAX_NESTED_ROWS, paginateByCursor, type CursorPage, type PaginationQuery } from "../pagination.js";
import {
  serializeEmailDetail,
  serializeEmailSummary,
  type EmailDetailResponse,
  type EmailSummaryResponse,
} from "../serializers/emailSerializer.js";
import { serializeAnalysisResult, type AnalysisResultResponse } from "../serializers/analysisSerializer.js";

/** Shared by every /emails/:id/* nested route — a single tenant-scoped existence check before querying the nested resource, so a wrong/cross-tenant email id always produces the same 404 rather than an empty-looking nested list. */
export async function assertEmailExists(tenantId: string, emailId: string): Promise<void> {
  const email = await prisma.email.findFirst({ where: { id: emailId, tenantId } });
  if (!email) throw new NotFoundError(`Email ${emailId} not found`);
}

export async function getEmailAnalysis(tenantId: string, emailId: string): Promise<AnalysisResultResponse> {
  await assertEmailExists(tenantId, emailId);
  const analysis = await prisma.analysisResult.findFirst({ where: { emailId }, orderBy: { createdAt: "desc" } });
  if (!analysis) throw new NotFoundError(`No analysis result exists yet for email ${emailId}`);
  return serializeAnalysisResult(analysis);
}

export interface ListEmailsQuery extends PaginationQuery {
  state?: string;
  mailboxConnectionId?: string;
  sender?: string;
  subject?: string;
  recipient?: string;
  destination?: string;
  receivedAfter?: Date;
  receivedBefore?: Date;
}

export async function listEmails(tenantId: string, query: ListEmailsQuery): Promise<CursorPage<EmailSummaryResponse>> {
  const where: Prisma.EmailWhereInput = { tenantId };
  if (query.state) where.state = query.state;
  if (query.mailboxConnectionId) where.mailboxConnectionId = query.mailboxConnectionId;
  if (query.sender) where.fromAddress = { contains: query.sender, mode: "insensitive" };
  if (query.subject) where.subject = { contains: query.subject, mode: "insensitive" };
  if (query.recipient) {
    // toAddresses is a text[]; Prisma has no case-insensitive "element contains", so match in SQL.
    const pattern = `%${query.recipient.replace(/[\\%_]/g, (c: string) => `\\${c}`)}%`;
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM email WHERE tenant_id = ${tenantId}
        AND EXISTS (SELECT 1 FROM unnest(to_addresses) AS a WHERE a ILIKE ${pattern})`;
    where.id = { in: rows.map((r) => r.id) };
  }
  if (query.destination) {
    const current: Prisma.RoutingDecisionWhereInput =
      query.destination === "human_review"
        ? { supersededAt: null, OR: [{ status: { notIn: ["matched", "sender_allowed"] } }, { status: "matched", destinationRef: "human_review" }] }
        : query.destination === "left_alone"
          ? { supersededAt: null, OR: [{ status: "sender_allowed" }, { status: "matched", destinationRef: "left_alone" }] }
          : { supersededAt: null, status: "matched", destinationRef: query.destination };
    where.routingDecisions = { some: current };
  }
  if (query.receivedAfter || query.receivedBefore) {
    where.receivedAt = {
      ...(query.receivedAfter ? { gte: query.receivedAfter } : {}),
      ...(query.receivedBefore ? { lte: query.receivedBefore } : {}),
    };
  }

  const page = await paginateByCursor(query, ({ cursorId, take }) =>
    prisma.email.findMany({
      where,
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take,
    }),
  );
  return { ...page, data: page.data.map(serializeEmailSummary) };
}

export async function getEmailDetail(tenantId: string, id: string, includeBody: boolean): Promise<EmailDetailResponse> {
  const email = await prisma.email.findFirst({ where: { id, tenantId } });
  if (!email) throw new NotFoundError(`Email ${id} not found`);

  const [analysis, routingDecision, previousRoutingDecisions, actionExecutions, reviewItems] = await Promise.all([
    prisma.analysisResult.findFirst({ where: { emailId: id }, orderBy: { createdAt: "desc" } }),
    prisma.routingDecision.findFirst({ where: { emailId: id, supersededAt: null } }),
    prisma.routingDecision.findMany({ where: { emailId: id, supersededAt: { not: null } }, orderBy: { createdAt: "desc" }, take: MAX_NESTED_ROWS }),
    prisma.actionExecution.findMany({ where: { emailId: id }, orderBy: { createdAt: "desc" }, take: MAX_NESTED_ROWS }),
    prisma.humanReviewItem.findMany({ where: { emailId: id }, orderBy: { createdAt: "desc" }, take: MAX_NESTED_ROWS }),
  ]);

  return serializeEmailDetail(email, { analysis, routingDecision, previousRoutingDecisions, actionExecutions, reviewItems, includeBody });
}
