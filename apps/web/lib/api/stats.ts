import { apiRequest } from "./client";
import type { StatsResponse } from "@/types/api";

export function getStats(signal?: AbortSignal) {
  return apiRequest<StatsResponse>("/api/v1/stats", { signal });
}
