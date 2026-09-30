"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listForwardRecipients, resendForwardVerification, revokeForwardRecipient, verifyForwardRecipient } from "@/lib/api/forwardRecipients";
import { useCurrentOrganizationId } from "@/lib/currentOrganization";

export function useForwardRecipients() {
  const organizationId = useCurrentOrganizationId();
  return useQuery({
    queryKey: ["forward-recipients", organizationId],
    queryFn: ({ signal }) => listForwardRecipients(signal),
  });
}

export function useForwardRecipientMutations() {
  const queryClient = useQueryClient();
  const onSuccess = () => void queryClient.invalidateQueries({ queryKey: ["forward-recipients"] });
  return {
    resend: useMutation({ mutationFn: (id: string) => resendForwardVerification(id), onSuccess }),
    revoke: useMutation({ mutationFn: (id: string) => revokeForwardRecipient(id), onSuccess }),
  };
}

export function useVerifyForwardRecipient() {
  return useMutation({ mutationFn: (token: string) => verifyForwardRecipient(token) });
}
