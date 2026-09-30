import { apiRequest } from "./client";
import type {
  CursorPage,
  ReviewDetailResponse,
  ReviewItemResponse,
  ReviewNoteResponse,
  ReviewerResponse,
} from "@/types/api";

export interface ListReviewsParams {
  limit?: number;
  cursor?: string;
  status?: "open" | "resolved";
  reason?: string;
  emailId?: string;
  /** Phase 28: "me", "none" (unassigned) or a user id. */
  assignedTo?: string;
  createdAfter?: string;
  createdBefore?: string;
}

export function listReviews(
  params: ListReviewsParams = {},
  signal?: AbortSignal,
) {
  return apiRequest<CursorPage<ReviewItemResponse>>("/api/v1/reviews", {
    query: params,
    signal,
  });
}

export function getReview(id: string, signal?: AbortSignal) {
  return apiRequest<ReviewDetailResponse>(`/api/v1/reviews/${id}`, { signal });
}

export type ReviewResolution = "approved" | "spam";

/** Idempotent on the backend — safe to call even if already resolved (returns the existing resolution unchanged, never overwritten by a later call). */
export function resolveReview(id: string, resolution?: ReviewResolution) {
  return apiRequest<ReviewItemResponse>(`/api/v1/reviews/${id}/resolve`, {
    method: "POST",
    body: resolution ? { resolution } : undefined,
  });
}

export interface SimilarReviewItem {
  id: string;
  emailId: string;
  subject: string | null;
  fromAddress: string;
  createdAt: string;
}

export interface SimilarReviewsResponse {
  /** The sender the items share: a domain, or a full address for public mail providers. */
  sender: string;
  /** This item's subject words, offered to narrow the list. */
  words: string[];
  word: string | null;
  items: SimilarReviewItem[];
  truncated: boolean;
}

/** The OTHER open items from the same sender, optionally only those whose subject contains `word`. */
export function getSimilarReviews(
  id: string,
  word?: string,
  signal?: AbortSignal,
) {
  return apiRequest<SimilarReviewsResponse>(`/api/v1/reviews/${id}/similar`, {
    query: { word },
    signal,
  });
}

export const MAX_BULK_RESOLVE = 200;

export interface BulkResolveResponse {
  resolved: number;
  skipped: number;
  data: ReviewItemResponse[];
}

/** Decides up to 200 items in one request; items that are no longer open are skipped. */
export function resolveReviews(
  itemIds: string[],
  resolution: ReviewResolution,
) {
  return apiRequest<BulkResolveResponse>("/api/v1/reviews/resolve", {
    method: "POST",
    body: { itemIds, resolution },
  });
}

export interface ReviewActionPreview {
  organizationName: string;
  resolution: ReviewResolution;
  subject: string | null;
  fromAddress: string;
  /** Already decided (by anyone) or closed by reprocessing — confirming does nothing. */
  alreadyClosed: boolean;
  status: string;
}

/** Public (no session): what a one-click digest link would decide. Never decides anything itself. */
export function previewReviewAction(token: string, signal?: AbortSignal) {
  return apiRequest<ReviewActionPreview>("/api/v1/review-actions/preview", {
    query: { token },
    signal,
  });
}

/** Public (no session): decides the item the signed link names. */
export function confirmReviewAction(token: string) {
  return apiRequest<ReviewActionPreview & { resolved: boolean }>(
    "/api/v1/review-actions",
    {
      method: "POST",
      body: { token },
    },
  );
}

/** Phase 28: members who can decide review items — who an item can be assigned to. */
export function listReviewAssignees(signal?: AbortSignal) {
  return apiRequest<{ data: ReviewerResponse[] }>("/api/v1/reviews/assignees", { signal });
}

/** Assigns the item to a member (null = unassign). Audited. */
export function assignReview(id: string, userId: string | null) {
  return apiRequest<ReviewItemResponse>(`/api/v1/reviews/${id}/assign`, { method: "POST", body: { userId } });
}

/** Adds a note; it is written to the audit log. */
export function addReviewNote(id: string, text: string) {
  return apiRequest<ReviewNoteResponse>(`/api/v1/reviews/${id}/notes`, { method: "POST", body: { text } });
}
