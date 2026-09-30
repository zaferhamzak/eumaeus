"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  acceptRuleSuggestion,
  addSenderEntry,
  decideSuggestion,
  dismissRuleSuggestion,
  listRuleSuggestions,
  listSenderEntries,
  listSuggestions,
  refreshRuleSuggestions,
  refreshSuggestions,
  removeSenderEntry,
  type AcceptRuleSuggestionInput,
} from "@/lib/api/senderLists";
import { useCurrentOrganizationId } from "@/lib/currentOrganization";

export function useSenderList() {
  const organizationId = useCurrentOrganizationId();
  return useQuery({ queryKey: ["sender-lists", organizationId], queryFn: ({ signal }) => listSenderEntries(signal) });
}

export function useSenderListMutations() {
  const queryClient = useQueryClient();
  const onSuccess = () => {
    void queryClient.invalidateQueries({ queryKey: ["sender-lists"] });
    void queryClient.invalidateQueries({ queryKey: ["routing-suggestions"] });
  };
  return {
    add: useMutation({ mutationFn: addSenderEntry, onSuccess }),
    remove: useMutation({ mutationFn: (id: string) => removeSenderEntry(id), onSuccess }),
  };
}

export function useSuggestions() {
  const organizationId = useCurrentOrganizationId();
  return useQuery({ queryKey: ["routing-suggestions", organizationId], queryFn: ({ signal }) => listSuggestions(signal) });
}

export function useSuggestionMutations() {
  const queryClient = useQueryClient();
  const onSuccess = () => {
    void queryClient.invalidateQueries({ queryKey: ["routing-suggestions"] });
    void queryClient.invalidateQueries({ queryKey: ["sender-lists"] });
  };
  return {
    refresh: useMutation({ mutationFn: refreshSuggestions, onSuccess }),
    decide: useMutation({ mutationFn: ({ id, action }: { id: string; action: "accept" | "dismiss" }) => decideSuggestion(id, action), onSuccess }),
  };
}

export function useRuleSuggestions() {
  const organizationId = useCurrentOrganizationId();
  return useQuery({ queryKey: ["rule-suggestions", organizationId], queryFn: ({ signal }) => listRuleSuggestions(signal) });
}

export function useRuleSuggestionMutations() {
  const queryClient = useQueryClient();
  const onSuccess = () => {
    void queryClient.invalidateQueries({ queryKey: ["rule-suggestions"] });
  };
  return {
    refresh: useMutation({ mutationFn: refreshRuleSuggestions, onSuccess }),
    accept: useMutation({
      mutationFn: ({ id, input }: { id: string; input: AcceptRuleSuggestionInput }) => acceptRuleSuggestion(id, input),
      onSuccess: () => {
        onSuccess();
        void queryClient.invalidateQueries({ queryKey: ["rules"] });
      },
    }),
    dismiss: useMutation({ mutationFn: (id: string) => dismissRuleSuggestion(id), onSuccess }),
  };
}
