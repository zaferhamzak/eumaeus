import { useQuery } from "@tanstack/react-query";
import { getLiveness, getMetrics, getReadiness } from "@/lib/api/health";

const HEALTH_POLL_INTERVAL_MS = 30_000;

export function useLiveness() {
  return useQuery({ queryKey: ["health", "liveness"], queryFn: ({ signal }) => getLiveness(signal), refetchInterval: HEALTH_POLL_INTERVAL_MS });
}

export function useReadiness() {
  return useQuery({ queryKey: ["health", "readiness"], queryFn: ({ signal }) => getReadiness(signal), refetchInterval: HEALTH_POLL_INTERVAL_MS });
}

export function useMetrics() {
  return useQuery({ queryKey: ["health", "metrics"], queryFn: ({ signal }) => getMetrics(signal), refetchInterval: HEALTH_POLL_INTERVAL_MS });
}
