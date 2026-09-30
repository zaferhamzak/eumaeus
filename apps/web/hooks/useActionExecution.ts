import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getActionExecution, retryActionExecution, undoActionExecution } from "@/lib/api/actionExecutions";
import type { ActionExecutionResponse } from "@/types/api";

/** Only polls while genuinely `pending` — a terminal ActionExecution (succeeded/failed/ambiguous) never changes again, so continuing to poll it would be exactly the "excessive polling" §25 warns against. */
export function useActionExecution(id: string) {
  return useQuery({
    queryKey: ["action-execution", id],
    queryFn: ({ signal }) => getActionExecution(id, signal),
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 5_000 : false),
  });
}

export function useUndoActionExecution(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => undoActionExecution(id),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["email"] });
      void queryClient.invalidateQueries({ queryKey: ["review"] });
      void queryClient.invalidateQueries({ queryKey: ["action-executions"] });
    },
  });
}

export function useRetryActionExecution(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => retryActionExecution(id),
    onSuccess: (data: ActionExecutionResponse) => {
      queryClient.setQueryData(["action-execution", id], data);
      // The email/review detail views embed a snapshot of this same
      // execution — invalidate broadly rather than trying to patch every
      // possible embedding location, so nothing shows stale terminal state
      // after a retry (§14's "refresh the server state").
      void queryClient.invalidateQueries({ queryKey: ["email"] });
      void queryClient.invalidateQueries({ queryKey: ["review"] });
      void queryClient.invalidateQueries({ queryKey: ["action-executions"] });
    },
  });
}
