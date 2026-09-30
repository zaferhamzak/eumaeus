import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRule, deactivateRule, getRule, listRules, listRuleVersions, revertRule, updateRule, type ListRulesParams, type RuleInput, type SaveRuleOptions } from "@/lib/api/rules";

const PAGE_SIZE = 50;

export function useRulesList(filters: Omit<ListRulesParams, "limit" | "cursor">) {
  return useInfiniteQuery({
    queryKey: ["rules", filters],
    queryFn: ({ pageParam, signal }) => listRules({ ...filters, limit: PAGE_SIZE, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => (lastPage.pagination.hasMore ? (lastPage.pagination.nextCursor ?? undefined) : undefined),
  });
}

export function useRule(id: string) {
  return useQuery({ queryKey: ["rule", id], queryFn: ({ signal }) => getRule(id, signal) });
}

export function useCreateRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ input, confirmImpact }: { input: RuleInput } & SaveRuleOptions) => createRule(input, { confirmImpact }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["rules"] }),
  });
}

/** Creates a NEW version server-side — never a mutation of the existing row (see lib/api/rules.ts). */
export function useUpdateRule(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ input, confirmImpact }: { input: RuleInput } & SaveRuleOptions) => updateRule(id, input, { confirmImpact }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["rules"] }),
  });
}

export function useDeactivateRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, confirmImpact }: { id: string } & SaveRuleOptions) => deactivateRule(id, { confirmImpact }),
    // Both the list and the rule's own detail query: the detail page otherwise
    // keeps showing the rule as active after it was deleted.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["rules"] });
      void queryClient.invalidateQueries({ queryKey: ["rule"] });
    },
  });
}

export function useRuleVersions(id: string) {
  return useQuery({ queryKey: ["rule", id, "versions"], queryFn: ({ signal }) => listRuleVersions(id, signal) });
}

export function useRevertRule(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { version: number; priority?: number; confirmImpact?: boolean }) => revertRule(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["rules"] });
      void queryClient.invalidateQueries({ queryKey: ["rule"] });
    },
  });
}
