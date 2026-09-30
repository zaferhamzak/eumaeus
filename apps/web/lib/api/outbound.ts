import { apiRequest } from "./client";
import type { CursorPage } from "@/types/api";

/** 1.2 (F): the delivery log (never the message bodies). */
export const OUTBOUND_KINDS = ["alert", "review_digest", "assignment", "invite", "forward_verification", "worker", "smtp_test", "forward", "forward_digest", "auto_reply", "rule_notify", "other"] as const;
export type OutboundKind = (typeof OUTBOUND_KINDS)[number];

export interface OutboundEmailResponse {
  id: string;
  kind: OutboundKind;
  toAddress: string;
  subject: string;
  status: "sent" | "failed";
  error: string | null;
  messageId: string | null;
  relatedId: string | null;
  createdAt: string;
  /** Only on the system administrator's list; null = a system email. */
  organization?: { id: string; name: string } | null;
}

export interface ListOutboundParams {
  limit?: number;
  cursor?: string;
  status?: "sent" | "failed";
  kind?: OutboundKind;
}

/** The current organization's sends (audit:read). */
export function listOutboundEmails(params: ListOutboundParams, signal?: AbortSignal) {
  return apiRequest<CursorPage<OutboundEmailResponse>>("/api/v1/outbound-emails", { query: params, signal });
}

/** Everything, system emails included (system administrator). */
export function listAllOutboundEmails(params: ListOutboundParams, signal?: AbortSignal) {
  return apiRequest<CursorPage<OutboundEmailResponse>>("/api/v1/admin/outbound-emails", { query: params, signal });
}
