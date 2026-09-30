import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createOrganization,
  deactivateOrganization,
  deleteOrganizationPermanently,
  getOrganization,
  reactivateOrganization,
  listOrganizations,
  updateOrganization,
  type CreateOrganizationInput,
  type UpdateOrganizationInput,
} from "@/lib/api/organizations";

export function useOrganizationsList() {
  return useQuery({ queryKey: ["organizations"], queryFn: ({ signal }) => listOrganizations({ limit: 100 }, signal) });
}

export function useOrganization(id: string) {
  return useQuery({ queryKey: ["organization", id], queryFn: ({ signal }) => getOrganization(id, signal) });
}

export function useCreateOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOrganizationInput) => createOrganization(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["organizations"] }),
  });
}

export function useUpdateOrganization(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateOrganizationInput) => updateOrganization(id, input),
    onSuccess: (data) => {
      queryClient.setQueryData(["organization", id], data);
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
    },
  });
}

/** Deactivate / reactivate: both refresh the organization and the lists. */
export function useSetOrganizationActive(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (active: boolean) => {
      if (active) await reactivateOrganization(id);
      else await deactivateOrganization(id);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["organizations"] }).then(() => queryClient.invalidateQueries({ queryKey: ["organization", id] })),
  });
}

export function useDeleteOrganizationPermanently(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (confirmName: string) => deleteOrganizationPermanently(id, confirmName),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["organizations"] }),
  });
}
