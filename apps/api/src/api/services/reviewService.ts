import type { Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { resolveReviewItem as domainResolve, ReviewResolutionError, type ReviewResolution } from "../../modules/review/resolveReview.js";
import { NotFoundError, ValidationError } from "../errors/ApiError.js";
import { assigneeEmails, listReviewNotes } from "../../modules/review/reviewTeamwork.js";
import { MAX_NESTED_ROWS, paginateByCursor, type CursorPage, type PaginationQuery } from "../pagination.js";
import {
  deriveReviewSignal,
  serializeReviewDetail,
  serializeReviewItem,
  type ReviewDetailResponse,
  type ReviewItemResponse,
} from "../serializers/reviewSerializer.js";

const RECENT_AUDIT_EVENTS_LIMIT = 20;

export interface ListReviewsQuery extends PaginationQuery {
  status?: string;
  reason?: string;
  emailId?: string;
  /** Already resolved by the route: a user id, or "none". */
  assignedTo?: string;
  createdAfter?: Date;
  createdBefore?: Date;
}

export async function listReviews(tenantId: string, query: ListReviewsQuery): Promise<CursorPage<ReviewItemResponse>> {
  const where: Prisma.HumanReviewItemWhereInput = { tenantId };
  if (query.status) where.status = query.status;
  if (query.reason) where.reason = query.reason;
  if (query.emailId) where.emailId = query.emailId;
  if (query.assignedTo) where.assignedTo = query.assignedTo === "none" ? null : query.assignedTo;
  if (query.createdAfter || query.createdBefore) {
    where.createdAt = {
      ...(query.createdAfter ? { gte: query.createdAfter } : {}),
      ...(query.createdBefore ? { lte: query.createdBefore } : {}),
    };
  }

  const page = await paginateByCursor(query, ({ cursorId, take }) =>
    prisma.humanReviewItem.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take,
    }),
  );

  // Phase 10.2: a real emailPreview + signal per row, fetched in two bulk
  // queries keyed by this page's email ids — not one query per row (§25:
  // "no N+1"). A page is at most limit+1 (≤101) rows, so both `in` queries
  // stay small and bounded regardless of total review-queue size.
  const emailIds = [...new Set(page.data.map((item) => item.emailId))];
  const [emails, analyses, assignees] = await Promise.all([
    prisma.email.findMany({ where: { id: { in: emailIds } }, select: { id: true, subject: true, fromAddress: true } }),
    prisma.analysisResult.findMany({ where: { emailId: { in: emailIds }, status: "ok" }, orderBy: { createdAt: "desc" } }),
    assigneeEmails(page.data.map((item) => item.assignedTo)),
  ]);

  const emailById = new Map(emails.map((e) => [e.id, e]));
  // First (most recent, since ordered desc) successful analysis per email wins.
  const latestAnalysisByEmail = new Map<string, (typeof analyses)[number]>();
  for (const analysis of analyses) {
    if (!latestAnalysisByEmail.has(analysis.emailId)) latestAnalysisByEmail.set(analysis.emailId, analysis);
  }

  return {
    ...page,
    data: page.data.map((item) => {
      const email = emailById.get(item.emailId);
      return serializeReviewItem(item, {
        emailPreview: email ? { subject: email.subject, fromAddress: email.fromAddress } : null,
        signal: deriveReviewSignal(latestAnalysisByEmail.get(item.emailId) ?? null),
        assignedToEmail: item.assignedTo ? (assignees.get(item.assignedTo) ?? null) : null,
      });
    }),
  };
}

export async function getReviewDetail(tenantId: string, id: string): Promise<ReviewDetailResponse> {
  const reviewItem = await prisma.humanReviewItem.findFirst({ where: { id, tenantId } });
  if (!reviewItem) throw new NotFoundError(`Review item ${id} not found`);

  const email = await prisma.email.findUniqueOrThrow({ where: { id: reviewItem.emailId } });
  const [analysis, routingDecision, actionExecutions, recentAuditEvents, notes, assignees] = await Promise.all([
    prisma.analysisResult.findFirst({ where: { emailId: email.id }, orderBy: { createdAt: "desc" } }),
    prisma.routingDecision.findFirst({ where: { emailId: email.id, supersededAt: null } }),
    prisma.actionExecution.findMany({ where: { emailId: email.id }, orderBy: { createdAt: "desc" }, take: MAX_NESTED_ROWS }),
    prisma.auditEvent.findMany({ where: { emailId: email.id }, orderBy: { createdAt: "desc" }, take: RECENT_AUDIT_EVENTS_LIMIT }),
    listReviewNotes(tenantId, reviewItem.id),
    assigneeEmails([reviewItem.assignedTo]),
  ]);

  return serializeReviewDetail(reviewItem, { email, analysis, routingDecision, actionExecutions, recentAuditEvents, notes, assignedToEmail: reviewItem.assignedTo ? (assignees.get(reviewItem.assignedTo) ?? null) : null });
}

export async function resolveReview(tenantId: string, id: string, resolution?: ReviewResolution, actor?: string): Promise<ReviewItemResponse> {
  try {
    const resolved = await domainResolve(tenantId, id, resolution, actor);
    if (!resolved) throw new NotFoundError(`Review item ${id} not found`);
    return serializeReviewItem(resolved);
  } catch (error) {
    if (error instanceof ReviewResolutionError) throw new ValidationError(error.message);
    throw error;
  }
}
