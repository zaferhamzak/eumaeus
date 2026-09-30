import { apiRequest } from "./client";
import type {
  LoginResponse,
  MeResponse,
  MembershipResponse,
  MfaEnrollResponse,
  SessionSummary,
} from "@/types/api";

export function login(email: string, password: string) {
  return apiRequest<LoginResponse>("/api/v1/auth/login", {
    method: "POST",
    body: { email, password },
  });
}

export function loginMfa(pendingToken: string, code: string) {
  return apiRequest<LoginResponse>("/api/v1/auth/login/mfa", {
    method: "POST",
    body: { pendingToken, code },
  });
}

export function logout() {
  return apiRequest<void>("/api/v1/auth/logout", { method: "POST" });
}

/** Phase 21: the signed-in person's language (null = follow the browser). */
export function saveLocale(locale: "en" | "tr" | null) {
  return apiRequest<{ locale: string | null }>("/api/v1/auth/me/locale", { method: "PUT", body: { locale } });
}

export function getMe(signal?: AbortSignal) {
  return apiRequest<MeResponse>("/api/v1/auth/me", { signal });
}

export function enrollMfa() {
  return apiRequest<MfaEnrollResponse>("/api/v1/auth/mfa/enroll", {
    method: "POST",
  });
}

export function confirmMfa(code: string) {
  return apiRequest<{ mfaEnabled: true }>("/api/v1/auth/mfa/confirm", {
    method: "POST",
    body: { code },
  });
}

export function disableMfa(code: string) {
  return apiRequest<{ mfaEnabled: false }>("/api/v1/auth/mfa/disable", {
    method: "POST",
    body: { code },
  });
}

export function acceptInvite(token: string, password: string) {
  return apiRequest<LoginResponse>("/api/v1/auth/accept-invite", {
    method: "POST",
    body: { token, password },
  });
}

export function listMembers(organizationId: string, signal?: AbortSignal) {
  return apiRequest<{ data: MembershipResponse[] }>(
    `/api/v1/organizations/${organizationId}/members`,
    { signal },
  );
}

export interface InviteMemberInput {
  email: string;
  permissions: string[];
}

export function inviteMember(organizationId: string, input: InviteMemberInput) {
  return apiRequest<{
    membership: MembershipResponse;
    inviteToken: string;
    acceptUrl: string;
    emailSent: boolean;
  }>(`/api/v1/organizations/${organizationId}/members`, {
    method: "POST",
    body: input,
  });
}

export function updateMember(
  organizationId: string,
  membershipId: string,
  input: { permissions?: string[]; status?: "active" | "revoked" },
) {
  return apiRequest<MembershipResponse>(
    `/api/v1/organizations/${organizationId}/members/${membershipId}`,
    { method: "PATCH", body: input },
  );
}

export function revokeMember(organizationId: string, membershipId: string) {
  return apiRequest<void>(
    `/api/v1/organizations/${organizationId}/members/${membershipId}`,
    { method: "DELETE" },
  );
}

export function changePassword(currentPassword: string, newPassword: string) {
  return apiRequest<{ otherSessionsRevoked: number }>("/api/v1/auth/password", {
    method: "POST",
    body: { currentPassword, newPassword },
  });
}

export function listSessions(signal?: AbortSignal) {
  return apiRequest<{ data: SessionSummary[] }>("/api/v1/auth/sessions", {
    signal,
  });
}

export function revokeSession(id: string) {
  return apiRequest<void>(`/api/v1/auth/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function revokeOtherSessions() {
  return apiRequest<{ revoked: number }>(
    "/api/v1/auth/sessions/revoke-others",
    { method: "POST" },
  );
}
