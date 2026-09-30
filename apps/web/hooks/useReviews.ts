import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addReviewNote,
  assignReview,
  listReviewAssignees,
  confirmReviewAction,
  getReview,
  getSimilarReviews,
  MAX_BULK_RESOLVE,
  listReviews,
  previewReviewAction,
  resolveReview,
  resolveReviews,
  type ListReviewsParams,
  type ReviewResolution,
} from "@/lib/api/review";
import { useCurrentOrganizationId } from "@/lib/currentOrganization";

const PAGE_SIZE = 25;
/** Human Review is the one list that changes on its own (new escalations arriving from the pipeline) frequently enough to justify a real interval — kept modest (§25: "do not aggressively poll everything"). */
const REVIEW_POLL_INTERVAL_MS = 30_000;

export function useReviewsList(filters: Omit<ListReviewsParams, "limit" | "cursor">) {
  return useInfiniteQuery({
    queryKey: ["reviews", filters],
    queryFn: ({ pageParam, signal }) => listReviews({ ...filters, limit: PAGE_SIZE, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => (lastPage.pagination.hasMore ? (lastPage.pagination.nextCursor ?? undefined) : undefined),
    refetchInterval: REVIEW_POLL_INTERVAL_MS,
  });
}

export function useReview(id: string) {
  return useQuery({
    queryKey: ["review", id],
    queryFn: ({ signal }) => getReview(id, signal),
  });
}

export function useResolveReview(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (resolution?: ReviewResolution) => resolveReview(id, resolution),
    onSuccess: async () => {
      // Refetch server state rather than assuming success locally (§13's
      // "do not assume success merely because the HTTP request returned
      // successfully" applies equally to resolve — the detail view and the
      // list must both reflect what the backend actually recorded).
      await queryClient.invalidateQueries({ queryKey: ["review", id] });
      await queryClient.invalidateQueries({ queryKey: ["reviews"] });
    },
  });
}

/** Other open items from the same sender as review `id`, optionally narrowed to a subject word. */
export function useSimilarReviews(id: string, word: string | null, enabled = true) {
  return useQuery({
    queryKey: ["review", id, "similar", word],
    queryFn: ({ signal }) => getSimilarReviews(id, word ?? undefined, signal),
    enabled,
    // Toggling a word keeps the current list on screen until the narrowed one arrives (no flicker/unmount).
    placeholderData: keepPreviousData,
  });
}

/** Many items per request (POST /reviews/resolve) — then both the list and every detail view refetch. */
export function useBulkResolveReviews() {
  const queryClient = useQueryClient();
  return useMutation({
    // The endpoint takes up to MAX_BULK_RESOLVE ids; larger selections go in consecutive requests.
    mutationFn: async ({ itemIds, resolution }: { itemIds: string[]; resolution: ReviewResolution }) => {
      let resolved = 0;
      let skipped = 0;
      for (let i = 0; i < itemIds.length; i += MAX_BULK_RESOLVE) {
        const result = await resolveReviews(itemIds.slice(i, i + MAX_BULK_RESOLVE), resolution);
        resolved += result.resolved;
        skipped += result.skipped;
      }
      return { resolved, skipped };
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["reviews"] });
      await queryClient.invalidateQueries({ queryKey: ["review"] });
    },
  });
}

/** Public digest link: preview only (a GET never decides — mail scanners prefetch links). */
export function useReviewActionPreview(token: string) {
  return useQuery({
    queryKey: ["review-action", token],
    queryFn: ({ signal }) => previewReviewAction(token, signal),
    enabled: token.length > 0,
    retry: false,
  });
}

export function useConfirmReviewAction() {
  return useMutation({ mutationFn: (token: string) => confirmReviewAction(token) });
}

export function useReviewAssignees(enabled = true) {
  const organizationId = useCurrentOrganizationId();
  return useQuery({ queryKey: ["review-assignees", organizationId], queryFn: ({ signal }) => listReviewAssignees(signal), enabled, staleTime: 60_000 });
}

export function useAssignReview(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string | null) => assignReview(id, userId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["review", id] });
      await queryClient.invalidateQueries({ queryKey: ["reviews"] });
    },
  });
}

export function useAddReviewNote(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => addReviewNote(id, text),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["review", id] }),
  });
}
