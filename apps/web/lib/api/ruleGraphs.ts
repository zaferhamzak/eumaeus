import { apiRequest } from "./client";
import type {
  CursorPage,
  RuleGraphInput,
  RuleGraphResponse,
  RuleGraphSummaryResponse,
} from "@/types/api";

export function listRuleGraphs(signal?: AbortSignal) {
  return apiRequest<CursorPage<RuleGraphSummaryResponse>>(
    "/api/v1/rule-graphs",
    { query: { limit: 100 }, signal },
  );
}

export function getRuleGraph(id: string, signal?: AbortSignal) {
  return apiRequest<RuleGraphResponse>(`/api/v1/rule-graphs/${id}`, { signal });
}

export function createRuleGraph(input: RuleGraphInput) {
  return apiRequest<RuleGraphResponse>("/api/v1/rule-graphs", {
    method: "POST",
    body: input,
  });
}

/** Saves a NEW version — the previous one is kept (deactivated), never overwritten. */
export function updateRuleGraph(id: string, input: RuleGraphInput) {
  return apiRequest<RuleGraphResponse>(`/api/v1/rule-graphs/${id}`, {
    method: "PATCH",
    body: input,
  });
}

export function setRuleGraphEnabled(id: string, enabled: boolean) {
  return apiRequest<RuleGraphResponse>(`/api/v1/rule-graphs/${id}/enabled`, {
    method: "PUT",
    body: { enabled },
  });
}

export function validateRuleGraph(input: RuleGraphInput) {
  return apiRequest<{ valid: boolean; errors: string[] }>(
    "/api/v1/rule-graphs/validate",
    { method: "POST", body: input },
  );
}
