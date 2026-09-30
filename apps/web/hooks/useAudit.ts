import { useInfiniteQuery } from "@tanstack/react-query";
import { listAudit, type ListAuditParams } from "@/lib/api/audit";

const PAGE_SIZE = 50;

export function useAuditList(filters: Omit<ListAuditParams, "limit" | "cursor">) {
  return useInfiniteQuery({
    queryKey: ["audit", filters],
    queryFn: ({ pageParam, signal }) => listAudit({ ...filters, limit: PAGE_SIZE, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => (lastPage.pagination.hasMore ? (lastPage.pagination.nextCursor ?? undefined) : undefined),
  });
}
