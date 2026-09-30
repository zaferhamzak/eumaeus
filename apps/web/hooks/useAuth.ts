import { useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  login,
  loginMfa,
  logout,
  getMe,
  enrollMfa,
  confirmMfa,
  disableMfa,
  acceptInvite,
  listMembers,
  inviteMember,
  updateMember,
  revokeMember,
  changePassword,
  listSessions,
  revokeSession,
  revokeOtherSessions,
  type InviteMemberInput,
} from "@/lib/api/auth";
import { useCurrentOrganizationId } from "@/lib/currentOrganization";
import { PERMISSION_CATALOG, type Permission } from "@/lib/permissions";

const noopSubscribe = () => () => {};

/**
 * false on the server and while React hydrates, true afterwards. React uses
 * the server snapshot during hydration, so this can't differ from the HTML.
 */
function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

/**
 * The frontend's "am I logged in" source of truth — session identity is server-authoritative (httpOnly cookie), so unlike current-organization there is no localStorage mirror; this react-query cache IS the state. `retry:false` so a 401 (not logged in) doesn't retry-loop.
 *
 * Until hydration finishes this always reports "loading", exactly what the
 * server rendered. Otherwise a Suspense boundary hydrating late (after the
 * sidebar already fetched /auth/me) would render permission-gated buttons the
 * server HTML doesn't have — a hydration mismatch.
 */
export function useMe() {
  const query = useQuery({ queryKey: ["auth", "me"], queryFn: ({ signal }) => getMe(signal), retry: false });
  const hydrated = useHydrated();
  if (hydrated) return query;
  return { ...query, data: undefined, isPending: true, isLoading: true, isSuccess: false, isError: false, error: null, status: "pending" } as unknown as typeof query;
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) => login(email, password),
    onSuccess: (result) => {
      if (!result.mfaRequired) queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });
}

export function useLoginMfa() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ pendingToken, code }: { pendingToken: string; code: string }) => loginMfa(pendingToken, code),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["auth", "me"] }),
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => logout(),
    onSuccess: () => queryClient.setQueryData(["auth", "me"], undefined),
  });
}

export function useEnrollMfa() {
  return useMutation({ mutationFn: () => enrollMfa() });
}

export function useConfirmMfa() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => confirmMfa(code),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["auth", "me"] }),
  });
}

export function useDisableMfa() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => disableMfa(code),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["auth", "me"] }),
  });
}

export function useAcceptInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ token, password }: { token: string; password: string }) => acceptInvite(token, password),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["auth", "me"] }),
  });
}

export function useMembers(organizationId: string) {
  return useQuery({ queryKey: ["members", organizationId], queryFn: ({ signal }) => listMembers(organizationId, signal) });
}

export function useInviteMember(organizationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: InviteMemberInput) => inviteMember(organizationId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["members", organizationId] }),
  });
}

export function useUpdateMember(organizationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ membershipId, input }: { membershipId: string; input: { permissions?: string[]; status?: "active" | "revoked" } }) =>
      updateMember(organizationId, membershipId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["members", organizationId] }),
  });
}

export function useRevokeMember(organizationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (membershipId: string) => revokeMember(organizationId, membershipId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["members", organizationId] }),
  });
}

/**
 * Does the caller have `permission` in the CURRENTLY SELECTED organization
 * (currentOrganization.ts)? superAdmin always true. Undefined while
 * useMe() is still loading — callers should treat that as "don't render
 * the gated action yet" rather than either extreme, avoiding a flash of a
 * button that then disappears.
 */
export function useHasPermission(permission: Permission): boolean | undefined {
  const me = useMe();
  const currentOrgId = useCurrentOrganizationId();
  if (me.isPending) return undefined;
  if (me.isError || !me.data) return false;
  if (me.data.user.isSuperAdmin) return true;
  if (!currentOrgId) return false;
  const membership = me.data.memberships.find((m) => m.organizationId === currentOrgId);
  return membership?.permissions.includes(permission) ?? false;
}

/**
 * The caller's permissions in ONE SPECIFIC organization (by id) — not the
 * globally "currently selected" one useHasPermission() reads. For pages
 * whose backend routes authorize against the URL's own :id
 * (requirePermission's paramName mode), e.g. the organization detail page.
 * superAdmin gets the whole catalog.
 */
export function useOrgPermissions(organizationId: string): string[] {
  const me = useMe();
  if (!me.data) return [];
  if (me.data.user.isSuperAdmin) return [...PERMISSION_CATALOG];
  return me.data.memberships.find((m) => m.organizationId === organizationId)?.permissions ?? [];
}

export function useChangePassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ currentPassword, newPassword }: { currentPassword: string; newPassword: string }) => changePassword(currentPassword, newPassword),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["auth", "sessions"] }),
  });
}

export function useSessions() {
  return useQuery({ queryKey: ["auth", "sessions"], queryFn: ({ signal }) => listSessions(signal) });
}

export function useRevokeSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeSession(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["auth", "sessions"] }),
  });
}

export function useRevokeOtherSessions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => revokeOtherSessions(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["auth", "sessions"] }),
  });
}
