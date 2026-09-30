import type { AnalysisResult, ActionExecution, AuditEvent, Email, HumanReviewItem, RoutingDecision } from "@prisma/client";
import type { ReviewNote } from "../../modules/review/reviewTeamwork.js";
import { serializeEmailSummary, type EmailSummaryResponse } from "./emailSerializer.js";
import { serializeAnalysisResult, type AnalysisResultResponse } from "./analysisSerializer.js";
import { serializeRoutingDecision, type RoutingDecisionResponse } from "./routingDecisionSerializer.js";
import { serializeActionExecution, type ActionExecutionResponse } from "./actionExecutionSerializer.js";
import { serializeAuditEvent, type AuditEventResponse } from "./auditEventSerializer.js";
import type { JevAnswer } from "../../modules/jev/response.js";

export interface ReviewEmailPreview {
  subject: string | null;
  fromAddress: string;
}

/**
 * Phase 10.2: a REAL signal, read directly off Jev's own `is_spam` answer
 * (already persisted on AnalysisResult.answers — see modules/jev/response.ts)
 * — never a separately invented "risk score". `isSuspicious` applies the
 * EXACT SAME 0.5 noul-to-boolean threshold already established and documented
 * in modules/rules/conditions.ts's NOUL_BOOLEAN_THRESHOLD, so a leaf like
 * `answers.is_spam == true` and this badge always agree on what "true" means
 * for the same underlying number. `category` is Jev's own real classification
 * choice (e.g. "support", "invoice"), not a generated summary.
 */
export interface ReviewSignal {
  isSpam: number | null;
  isSuspicious: boolean | null;
  category: string | null;
}

const NOUL_BOOLEAN_THRESHOLD = 0.5;

function readNoul(answer: JevAnswer | undefined): number | null {
  return answer && "noul" in answer ? answer.noul : null;
}

function readChoice(answer: JevAnswer | undefined): string | null {
  return answer && "choice" in answer ? answer.choice : null;
}

export function deriveReviewSignal(analysis: AnalysisResult | null): ReviewSignal | null {
  if (!analysis || analysis.status !== "ok" || !analysis.answers) return null;
  const answers = analysis.answers as Record<string, JevAnswer>;
  const isSpam = readNoul(answers.is_spam);
  return {
    isSpam,
    isSuspicious: isSpam === null ? null : isSpam >= NOUL_BOOLEAN_THRESHOLD,
    category: readChoice(answers.category),
  };
}

export interface ReviewItemResponse {
  id: string;
  tenantId: string;
  emailId: string;
  reason: string;
  status: string;
  resolution: string | null;
  assignedTo: string | null;
  /** Phase 28: the assignee's email, when the list/detail looked it up. */
  assignedToEmail?: string | null;
  resolvedAt: string | null;
  createdAt: string;
  emailPreview: ReviewEmailPreview | null;
  signal: ReviewSignal | null;
}

export function serializeReviewItem(
  row: HumanReviewItem,
  extra?: { emailPreview?: ReviewEmailPreview | null; signal?: ReviewSignal | null; assignedToEmail?: string | null },
): ReviewItemResponse {
  return {
    id: row.id,
    tenantId: row.tenantId,
    emailId: row.emailId,
    reason: row.reason,
    status: row.status,
    resolution: row.resolution,
    assignedTo: row.assignedTo,
    ...(extra?.assignedToEmail !== undefined ? { assignedToEmail: extra.assignedToEmail } : {}),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    emailPreview: extra?.emailPreview ?? null,
    signal: extra?.signal ?? null,
  };
}

export interface ReviewDetailResponse extends ReviewItemResponse {
  email: EmailSummaryResponse;
  analysis: AnalysisResultResponse | null;
  routingDecision: RoutingDecisionResponse | null;
  actionExecutions: ActionExecutionResponse[];
  /** Bounded (most recent N) — a full unbounded audit history belongs on GET /emails/:id/audit, not embedded here. */
  recentAuditEvents: AuditEventResponse[];
  /** Phase 28: notes left on the item, oldest first. */
  notes: ReviewNote[];
}

export interface ReviewDetailContext {
  email: Email;
  analysis: AnalysisResult | null;
  routingDecision: RoutingDecision | null;
  actionExecutions: ActionExecution[];
  recentAuditEvents: AuditEvent[];
  notes?: ReviewNote[];
  assignedToEmail?: string | null;
}

export function serializeReviewDetail(row: HumanReviewItem, ctx: ReviewDetailContext): ReviewDetailResponse {
  return {
    ...serializeReviewItem(row, {
      emailPreview: { subject: ctx.email.subject, fromAddress: ctx.email.fromAddress },
      signal: deriveReviewSignal(ctx.analysis),
      ...(ctx.assignedToEmail !== undefined ? { assignedToEmail: ctx.assignedToEmail } : {}),
    }),
    email: serializeEmailSummary(ctx.email),
    analysis: ctx.analysis ? serializeAnalysisResult(ctx.analysis) : null,
    routingDecision: ctx.routingDecision ? serializeRoutingDecision(ctx.routingDecision) : null,
    actionExecutions: ctx.actionExecutions.map(serializeActionExecution),
    recentAuditEvents: ctx.recentAuditEvents.map(serializeAuditEvent),
    notes: ctx.notes ?? [],
  };
}
