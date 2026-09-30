import type { Tenant } from "@prisma/client";
import { decryptSecret } from "../../modules/secrets/secretCrypto.js";

function webhookOrigin(encrypted: string | null): string | null {
  if (!encrypted) return null;
  try {
    return new URL(decryptSecret(encrypted)).origin;
  } catch {
    return "(set)";
  }
}

export interface OrganizationResponse {
  id: string;
  name: string;
  slug: string | null;
  status: string;
  humanReviewSignalEnabled: boolean;
  humanReviewSignalThreshold: number;
  reviewDigestEnabled: boolean;
  reviewDigestIntervalMinutes: number;
  assignmentNotifyEnabled: boolean;
  assignmentNotifyThreshold: number;
  lastReviewDigestAt: string | null;
  forwardDailyLimit: number;
  blockDestinationRef: string | null;
  alertEmailsEnabled: boolean;
  /** The webhook URL is never returned (it may carry a token) — only whether one is set and its origin. */
  alertWebhookOrigin: string | null;
  forwardAllowedDomains: string[];
  bodyRetentionDays: number | null;
  emailRetentionDays: number | null;
  locale: string;
  businessHours: { timeZone: string; days: number[]; start: string; end: string } | null;
  createdAt: string;
}

export function serializeOrganization(row: Tenant): OrganizationResponse {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    humanReviewSignalEnabled: row.humanReviewSignalEnabled,
    humanReviewSignalThreshold: row.humanReviewSignalThreshold,
    reviewDigestEnabled: row.reviewDigestEnabled,
    reviewDigestIntervalMinutes: row.reviewDigestIntervalMinutes,
    assignmentNotifyEnabled: row.assignmentNotifyEnabled,
    assignmentNotifyThreshold: row.assignmentNotifyThreshold,
    lastReviewDigestAt: row.lastReviewDigestAt ? row.lastReviewDigestAt.toISOString() : null,
    forwardDailyLimit: row.forwardDailyLimit,
    blockDestinationRef: row.blockDestinationRef,
    alertEmailsEnabled: row.alertEmailsEnabled,
    alertWebhookOrigin: webhookOrigin(row.alertWebhookUrlEncrypted),
    forwardAllowedDomains: row.forwardAllowedDomains,
    bodyRetentionDays: row.bodyRetentionDays,
    emailRetentionDays: row.emailRetentionDays,
    locale: row.locale,
    businessHours: (row.businessHours as OrganizationResponse["businessHours"]) ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
