import { useInfiniteQuery } from "@tanstack/react-query";
import { listAllOutboundEmails, listOutboundEmails, type ListOutboundParams } from "@/lib/api/outbound";

const PAGE_SIZE = 50;

/** 1.2 (F): the delivery log — this organization's, or (`all`) everything for the system administrator. */
export function useOutboundEmails(filters: Omit<ListOutboundParams, "limit" | "cursor">, all: boolean) {
  return useInfiniteQuery({
    queryKey: ["outbound", all ? "all" : "org", filters],
    queryFn: ({ pageParam, signal }) => (all ? listAllOutboundEmails : listOutboundEmails)({ ...filters, limit: PAGE_SIZE, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => (lastPage.pagination.hasMore ? (lastPage.pagination.nextCursor ?? undefined) : undefined),
  });
}
