import { apiRequest } from "./client";
import type { CursorPage, MailboxConnectionResponse } from "@/types/api";

export function listMailboxes(
  params: { limit?: number; cursor?: string; organizationId?: string } = {},
  signal?: AbortSignal,
) {
  return apiRequest<CursorPage<MailboxConnectionResponse>>(
    "/api/v1/mailboxes",
    { query: params, signal },
  );
}

export function getMailbox(id: string, signal?: AbortSignal) {
  return apiRequest<MailboxConnectionResponse>(`/api/v1/mailboxes/${id}`, {
    signal,
  });
}

export function setMailboxStatus(id: string, status: "active" | "disabled") {
  return apiRequest<MailboxConnectionResponse>(`/api/v1/mailboxes/${id}`, {
    method: "PATCH",
    body: { status },
  });
}

export interface CreateMailboxInput {
  organizationId: string;
  name: string;
  email: string;
  host: string;
  port: number;
  tls: boolean;
  folder: string;
  username: string;
  /** Sent once, over the same same-origin proxy every other request uses — never stored in this module, never logged. See components/mailboxes/CreateMailboxForm.tsx for how it's kept out of React state on the input side too. */
  password: string;
}

export function createMailbox(input: CreateMailboxInput) {
  return apiRequest<MailboxConnectionResponse>("/api/v1/mailboxes", {
    method: "POST",
    body: input,
  });
}

export function reconcileMailbox(id: string) {
  return apiRequest<{ status: string; jobId: string }>(
    `/api/v1/mailboxes/${id}/reconcile`,
    { method: "POST" },
  );
}

/** null unassigns — the mailbox then routes by the flat rule list. */
export function setMailboxRuleGraph(id: string, ruleGraphId: string | null) {
  return apiRequest<MailboxConnectionResponse>(`/api/v1/mailboxes/${id}`, {
    method: "PATCH",
    body: { ruleGraphId },
  });
}

export type OAuthProvider = "google" | "microsoft";

/** Phase 17: which sign-in providers the super admin has set up. */
export function getOAuthProviders(signal?: AbortSignal) {
  return apiRequest<Record<OAuthProvider, boolean>>(
    "/api/v1/mailboxes/oauth/providers",
    { signal },
  );
}

/** Phase 17: returns the provider URL to send the browser to. `mailboxConnectionId` reconnects an existing mailbox. */
export function startMailboxOAuth(
  provider: OAuthProvider,
  input: { folder?: string; mailboxConnectionId?: string; returnTo?: "organization" } = {},
  /** The organization to add the mailbox to (default: the current one). */
  organizationId?: string,
) {
  return apiRequest<{ authorizationUrl: string }>(
    `/api/v1/mailboxes/oauth/${provider}/start`,
    { method: "POST", body: input, organizationId },
  );
}

/** System administrator only; the mailbox must be disabled first. Deletes it with its emails. Cannot be undone. */
export function deleteMailboxPermanently(id: string, confirmAddress: string, organizationId?: string) {
  return apiRequest<{ emailAddress: string; emails: number }>(`/api/v1/mailboxes/${id}/delete-permanently`, { method: "POST", body: { confirmAddress }, organizationId });
}

/** A new password (and optionally username) for a password mailbox; a mailbox stopped by rejected sign-ins resumes. */
export function updateMailboxPassword(id: string, password: string, organizationId?: string, username?: string) {
  return apiRequest<MailboxConnectionResponse>(`/api/v1/mailboxes/${id}`, { method: "PATCH", body: { password, ...(username ? { username } : {}) }, organizationId });
}
