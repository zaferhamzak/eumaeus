import { apiRequest } from "./client";

/** Phase 20: an organization's API keys. The secret (`key`) exists only in the create response. */
export interface ApiKeyResponse {
  id: string;
  name: string;
  prefix: string;
  permissions: string[];
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: "active" | "expired" | "revoked";
}

export function listApiKeys(organizationId: string, signal?: AbortSignal) {
  return apiRequest<{ data: ApiKeyResponse[] }>("/api/v1/api-keys", {
    organizationId,
    signal,
  });
}

export function createApiKey(
  organizationId: string,
  input: { name: string; permissions: string[]; expiresInDays: number | null },
) {
  return apiRequest<ApiKeyResponse & { key: string }>("/api/v1/api-keys", {
    method: "POST",
    body: input,
    organizationId,
  });
}

export function revokeApiKey(organizationId: string, id: string) {
  return apiRequest<ApiKeyResponse>(`/api/v1/api-keys/${id}`, {
    method: "DELETE",
    organizationId,
  });
}
