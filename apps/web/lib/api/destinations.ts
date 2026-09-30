import { apiRequest } from "./client";
import type {
  CursorPage,
  DestinationResponse,
  DestinationSecretResponse,
} from "@/types/api";

export function listDestinations(
  params: { limit?: number; cursor?: string } = {},
  signal?: AbortSignal,
) {
  return apiRequest<CursorPage<DestinationResponse>>("/api/v1/destinations", {
    query: params,
    signal,
  });
}

export function getDestination(id: string, signal?: AbortSignal) {
  return apiRequest<DestinationResponse>(`/api/v1/destinations/${id}`, {
    signal,
  });
}

export interface CreateDestinationInput {
  name: string;
  description?: string;
  channels?: Array<{ type: string; config: Record<string, unknown> }>;
}

export function createDestination(input: CreateDestinationInput) {
  return apiRequest<DestinationResponse>("/api/v1/destinations", {
    method: "POST",
    body: input,
  });
}

export function updateDestination(
  id: string,
  input: { name?: string; description?: string },
) {
  return apiRequest<DestinationResponse>(`/api/v1/destinations/${id}`, {
    method: "PATCH",
    body: input,
  });
}

/** Disables every channel (soft) — never a hard delete on the backend. */
export function disableDestination(id: string) {
  return apiRequest<void>(`/api/v1/destinations/${id}`, { method: "DELETE" });
}

export function listDestinationSecrets(
  destinationId: string,
  signal?: AbortSignal,
) {
  return apiRequest<{ data: DestinationSecretResponse[] }>(
    `/api/v1/destinations/${destinationId}/secrets`,
    { signal },
  );
}

/**
 * The response never contains the plaintext (the backend's own serializer
 * structurally cannot include it — see manageSecrets.ts) — this function's
 * return type reflects that; do not widen it to include a value field.
 */
export function setDestinationSecret(
  destinationId: string,
  name: string,
  value: string,
) {
  return apiRequest<DestinationSecretResponse>(
    `/api/v1/destinations/${destinationId}/secrets/${encodeURIComponent(name)}`,
    {
      method: "PUT",
      body: { value },
    },
  );
}

export function deleteDestinationSecret(destinationId: string, name: string) {
  return apiRequest<void>(
    `/api/v1/destinations/${destinationId}/secrets/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
}

export interface ChannelInput {
  type:
    | "archive"
    | "webhook"
    | "forward"
    | "flag"
    | "auto_reply"
    | "slack"
    | "teams"
    | "jira"
    | "zendesk"
    | "email_notify";
  config: Record<string, unknown>;
}

/** 1.2 (O): what a notification channel's notice looks like for a real email. */
export interface NoticePreview {
  emailId: string | null;
  subject: string;
  html: string;
  text: string;
}

export function previewNotice(input: { config: Record<string, unknown>; destinationName?: string; emailId?: string }) {
  return apiRequest<NoticePreview>("/api/v1/destinations/notify-preview", { method: "POST", body: input });
}

/** Mails the notice to the signed-in person only. */
export function sendTestNotice(input: { config: Record<string, unknown>; destinationName?: string; emailId?: string }) {
  return apiRequest<{ to: string; sent: boolean; error: string | null; subject: string }>("/api/v1/destinations/notify-test", { method: "POST", body: input });
}

export function addDestinationChannel(
  destinationId: string,
  input: ChannelInput,
) {
  return apiRequest<DestinationResponse>(
    `/api/v1/destinations/${destinationId}/channels`,
    { method: "POST", body: input },
  );
}

export function editDestinationChannel(
  destinationId: string,
  channelId: string,
  config: Record<string, unknown>,
) {
  return apiRequest<DestinationResponse>(
    `/api/v1/destinations/${destinationId}/channels/${channelId}`,
    { method: "PATCH", body: { config } },
  );
}

export function disableDestinationChannel(
  destinationId: string,
  channelId: string,
) {
  return apiRequest<DestinationResponse>(
    `/api/v1/destinations/${destinationId}/channels/${channelId}`,
    { method: "DELETE" },
  );
}
