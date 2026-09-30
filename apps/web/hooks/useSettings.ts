import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSettings, testSmtp, updateSettings, type UpdateSettingsInput } from "@/lib/api/settings";

export function useSettings() {
  return useQuery({ queryKey: ["settings"], queryFn: ({ signal }) => getSettings(signal) });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSettingsInput) => updateSettings(input),
    onSuccess: (data) => queryClient.setQueryData(["settings"], data),
  });
}

export function useTestSmtp() {
  return useMutation({ mutationFn: (to: string) => testSmtp(to) });
}
