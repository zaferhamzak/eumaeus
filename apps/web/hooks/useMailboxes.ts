import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createMailbox, deleteMailboxPermanently, updateMailboxPassword, getOAuthProviders, listMailboxes, reconcileMailbox, setMailboxRuleGraph, setMailboxStatus, startMailboxOAuth, type CreateMailboxInput, type OAuthProvider } from "@/lib/api/mailboxes";

export function useMailboxesList(organizationId?: string) {
  return useQuery({
    queryKey: ["mailboxes", { organizationId }],
    queryFn: ({ signal }) => listMailboxes({ limit: 100, organizationId }, signal),
  });
}

export function useSetMailboxStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: "active" | "disabled" }) => setMailboxStatus(id, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["mailboxes"] }),
  });
}

export function useCreateMailbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMailboxInput) => createMailbox(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["mailboxes"] }),
  });
}

export function useReconcileMailbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => reconcileMailbox(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["mailboxes"] }),
  });
}

export function useSetMailboxRuleGraph() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ruleGraphId }: { id: string; ruleGraphId: string | null }) => setMailboxRuleGraph(id, ruleGraphId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["mailboxes"] }),
  });
}

export function useOAuthProviders() {
  return useQuery({ queryKey: ["mailbox-oauth-providers"], queryFn: ({ signal }) => getOAuthProviders(signal), staleTime: 60_000 });
}

/** Starts the sign-in and hands the browser to the provider; it comes back to /mailboxes, or to the organization's page with returnTo "organization". */
export function useStartMailboxOAuth() {
  return useMutation({
    mutationFn: ({ provider, mailboxConnectionId, organizationId, returnTo }: { provider: OAuthProvider; mailboxConnectionId?: string; organizationId?: string; returnTo?: "organization" }) =>
      startMailboxOAuth(provider, { ...(mailboxConnectionId ? { mailboxConnectionId } : {}), ...(returnTo ? { returnTo } : {}) }, organizationId),
    onSuccess: ({ authorizationUrl }) => window.location.assign(authorizationUrl),
  });
}

export function useDeleteMailboxPermanently() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, confirmAddress, organizationId }: { id: string; confirmAddress: string; organizationId?: string }) => deleteMailboxPermanently(id, confirmAddress, organizationId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["mailboxes"] }),
  });
}

export function useUpdateMailboxPassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, password, username, organizationId }: { id: string; password: string; username?: string; organizationId?: string }) => updateMailboxPassword(id, password, organizationId, username),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
      void queryClient.invalidateQueries({ queryKey: ["mailbox-health"] });
    },
  });
}
