import type { AnalysisResult, ActionExecution, Email, HumanReviewItem, RoutingDecision } from "@prisma/client";
import { readSenderAuth, type SenderAuth } from "../../modules/ingestion/senderAuth.js";
import { serializeAnalysisResult, type AnalysisResultResponse } from "./analysisSerializer.js";
import { serializeRoutingDecision, type RoutingDecisionResponse } from "./routingDecisionSerializer.js";
import { serializeActionExecution, type ActionExecutionResponse } from "./actionExecutionSerializer.js";
import { serializeReviewItem, type ReviewItemResponse } from "./reviewSerializer.js";

export interface EmailSummaryResponse {
  id: string;
  tenantId: string;
  mailboxConnectionId: string;
  provider: string;
  externalId: string;
  fromAddress: string;
  toAddresses: string[];
  subject: string | null;
  receivedAt: string;
  hasAttachments: boolean;
  state: string;
  stateUpdatedAt: string;
  ingestedAt: string;
}

export interface AttachmentMetaResponse {
  filename: string | null;
  contentType: string | null;
  size: number | null;
}

export interface EmailDetailResponse extends EmailSummaryResponse {
  ccAddresses: string[];
  bccAddresses: string[];
  messageId: string | null;
  threadId: string | null;
  uidValidity: number;
  attachments: AttachmentMetaResponse[];
  /**
   * Phase 27: the receiving provider's sender verdict. null = not captured
   * (ingested before 0.27, senderAuthCaptured false) or no verdict stamped.
   */
  senderAuthCaptured: boolean;
  senderAuth: SenderAuth | null;
  /**
   * Untrusted content (§11): this is the email's own raw text/HTML body,
   * exactly as ingested — never rendered, evaluated, or treated as
   * instructions by anything in this codebase (see
   * modules/mail-providers/imap/parse.ts's own security notes), and API
   * clients/operators must apply the same discipline: display it as inert
   * text/data, never interpret it as a command. Only present when the caller
   * explicitly opted in (`?includeBody=true`) — omitted by default.
   */
  body: { text: string | null; html: string | null; truncated: boolean } | null;
  /** Phase 20: when the retention policy removed the bodies (subject, analysis and decision remain). */
  bodyPurgedAt: string | null;
  analysis: AnalysisResultResponse | null;
  routingDecision: RoutingDecisionResponse | null;
  /** Phase 18: decisions replaced by a reprocess, newest first. */
  previousRoutingDecisions: RoutingDecisionResponse[];
  actionExecutions: ActionExecutionResponse[];
  reviewItems: ReviewItemResponse[];
}

export function serializeEmailSummary(row: Email): EmailSummaryResponse {
  return {
    id: row.id,
    tenantId: row.tenantId,
    mailboxConnectionId: row.mailboxConnectionId,
    provider: row.provider,
    externalId: row.externalId,
    fromAddress: row.fromAddress,
    toAddresses: row.toAddresses,
    subject: row.subject,
    receivedAt: row.receivedAt.toISOString(),
    hasAttachments: row.hasAttachments,
    state: row.state,
    stateUpdatedAt: row.stateUpdatedAt.toISOString(),
    ingestedAt: row.ingestedAt.toISOString(),
  };
}

/**
 * Phase 7 §15 — a response must never accidentally return an enormous email
 * body just because the underlying message happened to be huge; the STORED
 * content is never touched (only what this one response returns is capped).
 * Truncation is explicit (`truncated: true`), never silent.
 */
export const MAX_EMAIL_BODY_CHARS = 100_000;

function truncateBody(value: string | null): { value: string | null; truncated: boolean } {
  if (value === null || value.length <= MAX_EMAIL_BODY_CHARS) return { value, truncated: false };
  return { value: value.slice(0, MAX_EMAIL_BODY_CHARS), truncated: true };
}

function serializeAttachmentMeta(raw: unknown): AttachmentMetaResponse[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const item = (entry ?? {}) as { filename?: unknown; contentType?: unknown; size?: unknown };
    return {
      filename: typeof item.filename === "string" ? item.filename : null,
      contentType: typeof item.contentType === "string" ? item.contentType : null,
      size: typeof item.size === "number" ? item.size : null,
    };
  });
}

export interface EmailDetailContext {
  analysis: AnalysisResult | null;
  routingDecision: RoutingDecision | null;
  previousRoutingDecisions?: RoutingDecision[];
  actionExecutions: ActionExecution[];
  reviewItems: HumanReviewItem[];
  includeBody: boolean;
}

export function serializeEmailDetail(row: Email, ctx: EmailDetailContext): EmailDetailResponse {
  let body: EmailDetailResponse["body"] = null;
  if (ctx.includeBody) {
    const text = truncateBody(row.textBody);
    const html = truncateBody(row.htmlBody);
    body = { text: text.value, html: html.value, truncated: text.truncated || html.truncated };
  }

  return {
    ...serializeEmailSummary(row),
    ccAddresses: row.ccAddresses,
    bccAddresses: row.bccAddresses,
    messageId: row.messageId,
    threadId: row.threadId,
    uidValidity: row.uidValidity,
    attachments: serializeAttachmentMeta(row.attachmentMeta),
    senderAuthCaptured: row.senderAuthCaptured,
    senderAuth: readSenderAuth(row.senderAuth),
    body,
    bodyPurgedAt: row.bodyPurgedAt ? row.bodyPurgedAt.toISOString() : null,
    analysis: ctx.analysis ? serializeAnalysisResult(ctx.analysis) : null,
    routingDecision: ctx.routingDecision ? serializeRoutingDecision(ctx.routingDecision) : null,
    previousRoutingDecisions: (ctx.previousRoutingDecisions ?? []).map(serializeRoutingDecision),
    actionExecutions: ctx.actionExecutions.map(serializeActionExecution),
    reviewItems: ctx.reviewItems.map((item) => serializeReviewItem(item)),
  };
}
