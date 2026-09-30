import { apiRequest } from "./client";
import type { CursorPage, RoutingDecisionResponse } from "@/types/api";

export function listRoutingDecisions(
  params: { limit?: number; cursor?: string } = {},
  signal?: AbortSignal,
) {
  return apiRequest<CursorPage<RoutingDecisionResponse>>(
    "/api/v1/routing-decisions",
    { query: params, signal },
  );
}

export function getRoutingDecision(id: string, signal?: AbortSignal) {
  return apiRequest<RoutingDecisionResponse>(
    `/api/v1/routing-decisions/${id}`,
    { signal },
  );
}
