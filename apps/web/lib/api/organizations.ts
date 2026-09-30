import { apiRequest } from "./client";
import type { CursorPage, OrganizationResponse } from "@/types/api";

export function listOrganizations(
  params: { limit?: number; cursor?: string } = {},
  signal?: AbortSignal,
) {
  return apiRequest<CursorPage<OrganizationResponse>>("/api/v1/organizations", {
    query: params,
    signal,
  });
}

export function getOrganization(id: string, signal?: AbortSignal) {
  return apiRequest<OrganizationResponse>(`/api/v1/organizations/${id}`, {
    signal,
  });
}

export interface CreateOrganizationInput {
  name: string;
  slug: string;
}

export function createOrganization(input: CreateOrganizationInput) {
  return apiRequest<OrganizationResponse>("/api/v1/organizations", {
    method: "POST",
    body: input,
  });
}

export interface UpdateOrganizationInput {
  name?: string;
  slug?: string;
  humanReviewSignalEnabled?: boolean;
  humanReviewSignalThreshold?: number;
  reviewDigestEnabled?: boolean;
  reviewDigestIntervalMinutes?: number;
  assignmentNotifyEnabled?: boolean;
  assignmentNotifyThreshold?: number;
  forwardDailyLimit?: number;
  forwardAllowedDomains?: string[];
  blockDestinationRef?: string | null;
  alertEmailsEnabled?: boolean;
  /** "" or null removes it. */
  alertWebhookUrl?: string | null;
  /** Phase 20: days; null = keep forever. */
  bodyRetentionDays?: number | null;
  emailRetentionDays?: number | null;
  locale?: "en" | "tr";
  /** Phase 22: null clears them. */
  businessHours?: {
    timeZone: string;
    days: number[];
    start: string;
    end: string;
  } | null;
}

export function updateOrganization(id: string, input: UpdateOrganizationInput) {
  return apiRequest<OrganizationResponse>(`/api/v1/organizations/${id}`, {
    method: "PATCH",
    body: input,
  });
}

export interface SenderErasureResult {
  dryRun: boolean;
  address: string;
  emails: number;
  autoReplyRecords: number;
  suggestions: number;
  senderListEntries: number;
}

/** Phase 20: KVKK/GDPR — counts (dryRun) or deletes everything this organization holds from one sender. */
export function eraseSender(
  organizationId: string,
  address: string,
  dryRun: boolean,
) {
  return apiRequest<SenderErasureResult>("/api/v1/privacy/erase-sender", {
    method: "POST",
    body: { address, dryRun },
    organizationId,
  });
}

/** Deactivates (reversible): its mailboxes stop syncing. */
export function deactivateOrganization(id: string) {
  return apiRequest<void>(`/api/v1/organizations/${id}`, { method: "DELETE" });
}

export function reactivateOrganization(id: string) {
  return apiRequest<OrganizationResponse>(`/api/v1/organizations/${id}/reactivate`, { method: "POST" });
}

/** System administrator only; the organization must be deactivated first. Cannot be undone. */
export function deleteOrganizationPermanently(id: string, confirmName: string) {
  return apiRequest<{ name: string; mailboxes: number; emails: number }>(`/api/v1/organizations/${id}/delete-permanently`, { method: "POST", body: { confirmName } });
}
