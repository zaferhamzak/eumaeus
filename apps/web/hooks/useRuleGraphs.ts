import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRuleGraph, getRuleGraph, listRuleGraphs, setRuleGraphEnabled, updateRuleGraph, validateRuleGraph } from "@/lib/api/ruleGraphs";
import type { RuleGraphInput } from "@/types/api";

export function useRuleGraphsList() {
  return useQuery({ queryKey: ["rule-graphs"], queryFn: ({ signal }) => listRuleGraphs(signal) });
}

export function useRuleGraph(id: string) {
  return useQuery({ queryKey: ["rule-graph", id], queryFn: ({ signal }) => getRuleGraph(id, signal) });
}

export function useCreateRuleGraph() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RuleGraphInput) => createRuleGraph(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["rule-graphs"] }),
  });
}

export function useUpdateRuleGraph(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RuleGraphInput) => updateRuleGraph(id, input),
    onSuccess: (data) => {
      queryClient.setQueryData(["rule-graph", id], data);
      void queryClient.invalidateQueries({ queryKey: ["rule-graphs"] });
    },
  });
}

export function useSetRuleGraphEnabled(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => setRuleGraphEnabled(id, enabled),
    onSuccess: (data) => {
      queryClient.setQueryData(["rule-graph", id], data);
      void queryClient.invalidateQueries({ queryKey: ["rule-graphs"] });
    },
  });
}

export function useValidateRuleGraph() {
  return useMutation({ mutationFn: (input: RuleGraphInput) => validateRuleGraph(input) });
}
