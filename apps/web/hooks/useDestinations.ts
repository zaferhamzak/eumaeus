import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createDestination,
  deleteDestinationSecret,
  disableDestination,
  getDestination,
  listDestinations,
  listDestinationSecrets,
  setDestinationSecret,
  updateDestination,
  addDestinationChannel,
  editDestinationChannel,
  disableDestinationChannel,
  type CreateDestinationInput,
  type ChannelInput,
} from "@/lib/api/destinations";

export function useDestinationsList() {
  return useQuery({ queryKey: ["destinations"], queryFn: ({ signal }) => listDestinations({ limit: 100 }, signal) });
}

export function useDestination(id: string) {
  return useQuery({ queryKey: ["destination", id], queryFn: ({ signal }) => getDestination(id, signal) });
}

export function useCreateDestination() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDestinationInput) => createDestination(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["destinations"] });
      // Saving a forward channel registers its addresses as (pending) forward recipients.
      void queryClient.invalidateQueries({ queryKey: ["forward-recipients"] });
    },
  });
}

export function useUpdateDestination(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name?: string; description?: string }) => updateDestination(id, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["destination", id] });
      await queryClient.invalidateQueries({ queryKey: ["destinations"] });
    },
  });
}

export function useDisableDestination() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => disableDestination(id),
    onSuccess: async (_data, id) => {
      await queryClient.invalidateQueries({ queryKey: ["destination", id] });
      await queryClient.invalidateQueries({ queryKey: ["destinations"] });
    },
  });
}

export function useDestinationSecrets(destinationId: string) {
  return useQuery({
    queryKey: ["destination", destinationId, "secrets"],
    queryFn: ({ signal }) => listDestinationSecrets(destinationId, signal),
  });
}

export function useSetDestinationSecret(destinationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, value }: { name: string; value: string }) => setDestinationSecret(destinationId, name, value),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["destination", destinationId, "secrets"] }),
  });
}

export function useDeleteDestinationSecret(destinationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deleteDestinationSecret(destinationId, name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["destination", destinationId, "secrets"] }),
  });
}

/** All three channel mutations return the full updated destination — written straight into the cache, no refetch. */
export function useChannelMutations(destinationId: string) {
  const queryClient = useQueryClient();
  const onSuccess = (data: Awaited<ReturnType<typeof addDestinationChannel>>) => {
    queryClient.setQueryData(["destination", destinationId], data);
    void queryClient.invalidateQueries({ queryKey: ["destinations"] });
    void queryClient.invalidateQueries({ queryKey: ["forward-recipients"] });
  };
  return {
    add: useMutation({ mutationFn: (input: ChannelInput) => addDestinationChannel(destinationId, input), onSuccess }),
    edit: useMutation({
      mutationFn: ({ channelId, config }: { channelId: string; config: Record<string, unknown> }) => editDestinationChannel(destinationId, channelId, config),
      onSuccess,
    }),
    disable: useMutation({ mutationFn: (channelId: string) => disableDestinationChannel(destinationId, channelId), onSuccess }),
  };
}
