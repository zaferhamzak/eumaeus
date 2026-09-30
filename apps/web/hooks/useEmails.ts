import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { correctEmail, deleteEmails, getCorrectionRule, getEmail, getEmailAnalysis, getEmailRouting, listEmailAudit, listEmailExecutions, listEmails, type ListEmailsParams } from "@/lib/api/emails";
import { ApiRequestError } from "@/lib/api/client";

const PAGE_SIZE = 25;

export function useEmailsList(filters: Omit<ListEmailsParams, "limit" | "cursor">) {
  return useInfiniteQuery({
    queryKey: ["emails", filters],
    queryFn: ({ pageParam, signal }) => listEmails({ ...filters, limit: PAGE_SIZE, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => (lastPage.pagination.hasMore ? (lastPage.pagination.nextCursor ?? undefined) : undefined),
  });
}

export function useEmail(id: string, includeBody = false) {
  return useQuery({
    queryKey: ["email", id, { includeBody }],
    queryFn: ({ signal }) => getEmail(id, includeBody, signal),
    retry: (failureCount, error) => error instanceof ApiRequestError && error.status === 404 ? false : failureCount < 1,
  });
}

export function useEmailAnalysis(id: string) {
  return useQuery({
    queryKey: ["email", id, "analysis"],
    queryFn: ({ signal }) => getEmailAnalysis(id, signal),
    retry: (failureCount, error) => (error instanceof ApiRequestError && error.status === 404 ? false : failureCount < 1),
  });
}

export function useEmailRouting(id: string) {
  return useQuery({
    queryKey: ["email", id, "routing"],
    queryFn: ({ signal }) => getEmailRouting(id, signal),
    retry: (failureCount, error) => (error instanceof ApiRequestError && error.status === 404 ? false : failureCount < 1),
  });
}

export function useEmailExecutions(id: string) {
  return useQuery({
    queryKey: ["email", id, "executions"],
    queryFn: ({ signal }) => listEmailExecutions(id, { limit: 50 }, signal),
  });
}

export function useEmailAudit(id: string) {
  return useQuery({
    queryKey: ["email", id, "audit"],
    queryFn: ({ signal }) => listEmailAudit(id, { limit: 50 }, signal),
  });
}

/** Phase 24: put this email where it belongs (a destination name, or "inbox"). */
export function useCorrectEmail(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (destinationRef: string) => correctEmail(id, destinationRef),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["email"] });
      void queryClient.invalidateQueries({ queryKey: ["emails"] });
      void queryClient.invalidateQueries({ queryKey: ["reviews"] });
    },
  });
}

/** Phase 24: the "stop this happening again" rule draft; `params` null = not loaded yet. */
export function useCorrectionRule(id: string, params: { destinationRef: string; wrong: string | null } | null, enabled = true) {
  return useQuery({
    queryKey: ["correction-rule", id, params?.destinationRef ?? null, params?.wrong ?? null],
    queryFn: ({ signal }) => getCorrectionRule(id, params!, signal),
    enabled: enabled && params !== null,
    staleTime: Infinity,
  });
}

export function useDeleteEmails() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (emailIds: string[]) => deleteEmails(emailIds),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["emails"] }),
  });
}
