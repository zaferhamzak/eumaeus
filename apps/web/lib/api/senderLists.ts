import { apiRequest } from "./client";
import type { RuleImpact } from "./rules";
import type {
  ConditionNode,
  RoutingSuggestionResponse,
  SenderListEntryResponse,
} from "@/types/api";

export function listSenderEntries(signal?: AbortSignal) {
  return apiRequest<{
    data: SenderListEntryResponse[];
    blockDestinationRef: string | null;
  }>("/api/v1/sender-lists", { signal });
}

export function addSenderEntry(input: {
  kind: "allow" | "block";
  pattern: string;
  note?: string;
}) {
  return apiRequest<SenderListEntryResponse>("/api/v1/sender-lists", {
    method: "POST",
    body: input,
  });
}

export function removeSenderEntry(id: string) {
  return apiRequest<void>(`/api/v1/sender-lists/${id}`, { method: "DELETE" });
}

export function listSuggestions(signal?: AbortSignal) {
  return apiRequest<{ data: RoutingSuggestionResponse[] }>(
    "/api/v1/routing-suggestions",
    { signal },
  );
}

export function refreshSuggestions() {
  return apiRequest<{ data: RoutingSuggestionResponse[] }>(
    "/api/v1/routing-suggestions/refresh",
    { method: "POST" },
  );
}

export function decideSuggestion(id: string, action: "accept" | "dismiss") {
  return apiRequest<RoutingSuggestionResponse>(
    `/api/v1/routing-suggestions/${id}/${action}`,
    { method: "POST" },
  );
}

/** A rule proposed from Human Review decisions sharing a sender and a subject word. */
export interface RuleSuggestion {
  id: string;
  kind: "rule";
  pattern: string;
  status: string;
  resolvedCount: number;
  spamCount: number;
  approvedCount: number;
  createdAt: string;
  updatedAt?: string;
  sender: string;
  word: string;
  decision: "spam" | "approved";
  draft: {
    name: string;
    priority: number;
    conditions: ConditionNode;
    destinationRef: string | null;
    affected: number;
  };
}

export interface AcceptRuleSuggestionInput {
  destinationRef?: string;
  priority?: number;
  name?: string;
  confirmImpact?: boolean;
}

export type AcceptedRuleSuggestion = RuleSuggestion & {
  ruleId: string;
  impact: RuleImpact | null;
};

export function listRuleSuggestions(signal?: AbortSignal) {
  return apiRequest<{ data: RuleSuggestion[] }>("/api/v1/rule-suggestions", {
    signal,
  });
}

export function refreshRuleSuggestions() {
  return apiRequest<{ data: RuleSuggestion[] }>(
    "/api/v1/rule-suggestions/refresh",
    { method: "POST" },
  );
}

export function acceptRuleSuggestion(
  id: string,
  input: AcceptRuleSuggestionInput = {},
) {
  return apiRequest<AcceptedRuleSuggestion>(
    `/api/v1/rule-suggestions/${id}/accept`,
    { method: "POST", body: input },
  );
}

export function dismissRuleSuggestion(id: string) {
  return apiRequest<RuleSuggestion>(`/api/v1/rule-suggestions/${id}/dismiss`, {
    method: "POST",
  });
}
