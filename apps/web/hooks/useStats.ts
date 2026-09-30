import { useQuery } from "@tanstack/react-query";
import { getStats } from "@/lib/api/stats";

export function useStats() {
  return useQuery({ queryKey: ["stats"], queryFn: ({ signal }) => getStats(signal), refetchInterval: 30_000 });
}
