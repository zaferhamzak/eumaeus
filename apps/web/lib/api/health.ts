import { apiRequest } from "./client";
import type {
  LivenessResponse,
  MetricsSnapshot,
  ReadinessResponse,
} from "@/types/api";

export function getLiveness(signal?: AbortSignal) {
  return apiRequest<LivenessResponse>("/api/v1/health", { signal });
}

export function getReadiness(signal?: AbortSignal) {
  return apiRequest<ReadinessResponse>("/api/v1/ready", { signal });
}

export function getMetrics(signal?: AbortSignal) {
  return apiRequest<MetricsSnapshot>("/metrics", { signal });
}
