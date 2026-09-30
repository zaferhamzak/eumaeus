import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS } from "../privacy/retention.js";
import { encryptSecret } from "../secrets/secretCrypto.js";
import { Prisma, type Tenant } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { recordAuditEvent, AuditEventType } from "../audit/record.js";
import { validateBusinessHours } from "../rules/derivedFields.js";

/**
 * Organization CRUD, operating on the existing `Tenant` table — see
 * schema.prisma's Tenant header comment for why a separate `Organization`
 * table was not introduced. "Organization" is this row's public API name;
 * "Tenant" is unchanged everywhere else in the codebase.
 */
export type OrganizationStatus = "active" | "disabled";

export interface OrganizationInput {
  name: string;
  slug?: string;
}

export class OrganizationValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Invalid organization configuration: ${errors.join("; ")}`);
    this.name = "OrganizationValidationError";
  }
}

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function validateOrganizationInput(input: OrganizationInput, requireSlug: boolean): string[] {
  const errors: string[] = [];
  if (!input.name.trim()) errors.push("name must not be empty");
  if (input.slug !== undefined) {
    if (!SLUG_PATTERN.test(input.slug)) {
      errors.push("slug must be lowercase alphanumeric segments separated by single hyphens (e.g. \"acme-security\")");
    }
  } else if (requireSlug) {
    errors.push("slug must not be empty");
  }
  return errors;
}

export async function createOrganization(input: OrganizationInput, actor = "system"): Promise<Tenant> {
  const errors = validateOrganizationInput(input, true);
  if (errors.length > 0) throw new OrganizationValidationError(errors);

  if (input.slug) {
    const conflict = await prisma.tenant.findUnique({ where: { slug: input.slug } });
    if (conflict) throw new OrganizationValidationError([`slug "${input.slug}" is already in use`]);
  }

  const org = await prisma.tenant.create({ data: { name: input.name, slug: input.slug, status: "active" } });
  await recordAuditEvent(prisma, {
    tenantId: org.id,
    eventType: AuditEventType.ORGANIZATION_CREATED,
    actor,
    payload: { organizationId: org.id, name: org.name, slug: org.slug },
  });
  return org;
}

export async function getOrganizationById(id: string): Promise<Tenant | null> {
  return prisma.tenant.findUnique({ where: { id } });
}

export async function listOrganizations(): Promise<Tenant[]> {
  return prisma.tenant.findMany({ orderBy: { createdAt: "desc" } });
}

export interface OrganizationUpdateInput extends Partial<OrganizationInput> {
  humanReviewSignalEnabled?: boolean;
  humanReviewSignalThreshold?: number;
  reviewDigestEnabled?: boolean;
  reviewDigestIntervalMinutes?: number;
  /** Email members about items assigned to them, once this many have gathered (1–100). */
  assignmentNotifyEnabled?: boolean;
  assignmentNotifyThreshold?: number;
  forwardDailyLimit?: number;
  /** Phase 16: where blocked senders' mail goes; null = Human Review. */
  blockDestinationRef?: string | null;
  /** Phase 18: operational alert emails on/off. */
  alertEmailsEnabled?: boolean;
  /** Phase 18: "" or null clears; otherwise an http(s) URL, stored encrypted. */
  alertWebhookUrl?: string | null;
  /** Replaces the whole list. Entries are normalized to lowercase bare domains ("@acme.com" → "acme.com"). */
  forwardAllowedDomains?: string[];
  /** Phase 20: days; null = keep forever. */
  bodyRetentionDays?: number | null;
  emailRetentionDays?: number | null;
  /** Phase 21: language of emails to people who aren't users. */
  locale?: "en" | "tr";
  /** Phase 22: working hours for the email.business_hours condition; null clears. */
  businessHours?: { timeZone: string; days: number[]; start: string; end: string } | null;
}

const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function normalizeDomains(domains: string[]): { domains: string[]; errors: string[] } {
  const errors: string[] = [];
  const out = new Set<string>();
  for (const entry of domains) {
    const domain = entry.trim().toLowerCase().replace(/^@/, "");
    if (!DOMAIN_PATTERN.test(domain)) errors.push(`"${entry}" is not a valid domain`);
    else out.add(domain);
  }
  return { domains: [...out], errors };
}

export async function updateOrganization(id: string, input: OrganizationUpdateInput, actor = "system"): Promise<Tenant | null> {
  const existing = await prisma.tenant.findUnique({ where: { id } });
  if (!existing) return null;

  const errors = validateOrganizationInput(
    { name: input.name ?? existing.name, slug: input.slug ?? existing.slug ?? undefined },
    false,
  );
  if (input.humanReviewSignalThreshold !== undefined && (input.humanReviewSignalThreshold < 0 || input.humanReviewSignalThreshold > 1)) {
    errors.push("humanReviewSignalThreshold must be between 0 and 1");
  }
  if (input.reviewDigestIntervalMinutes !== undefined && (input.reviewDigestIntervalMinutes < 5 || input.reviewDigestIntervalMinutes > 10080)) {
    errors.push("reviewDigestIntervalMinutes must be between 5 and 10080 (one week)");
  }
  if (input.assignmentNotifyThreshold !== undefined && (!Number.isInteger(input.assignmentNotifyThreshold) || input.assignmentNotifyThreshold < 1 || input.assignmentNotifyThreshold > 100)) {
    errors.push("assignmentNotifyThreshold must be a whole number between 1 and 100");
  }
  if (input.alertWebhookUrl) {
    try {
      const url = new URL(input.alertWebhookUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") errors.push("alertWebhookUrl must be an http or https URL");
    } catch {
      errors.push("alertWebhookUrl is not a valid URL");
    }
  }
  if (input.blockDestinationRef !== undefined && input.blockDestinationRef !== null && (!input.blockDestinationRef.trim() || input.blockDestinationRef.length > 200)) {
    errors.push("blockDestinationRef must be a destination name or null");
  }
  if (input.forwardDailyLimit !== undefined && (!Number.isInteger(input.forwardDailyLimit) || input.forwardDailyLimit < 0 || input.forwardDailyLimit > 10000)) {
    errors.push("forwardDailyLimit must be a whole number between 0 and 10000");
  }
  for (const key of ["bodyRetentionDays", "emailRetentionDays"] as const) {
    const v = input[key];
    if (v !== undefined && v !== null && (!Number.isInteger(v) || v < MIN_RETENTION_DAYS || v > MAX_RETENTION_DAYS)) {
      errors.push(`${key} must be a whole number of days between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}, or null`);
    }
  }
  const bodyDays = input.bodyRetentionDays !== undefined ? input.bodyRetentionDays : existing.bodyRetentionDays;
  const emailDays = input.emailRetentionDays !== undefined ? input.emailRetentionDays : existing.emailRetentionDays;
  if (bodyDays && emailDays && bodyDays > emailDays) errors.push("bodyRetentionDays can't be longer than emailRetentionDays (the whole email is gone by then)");
  if (input.businessHours) errors.push(...validateBusinessHours(input.businessHours));
  const allowedDomains = input.forwardAllowedDomains !== undefined ? normalizeDomains(input.forwardAllowedDomains) : undefined;
  if (allowedDomains) errors.push(...allowedDomains.errors);
  if (errors.length > 0) throw new OrganizationValidationError(errors);

  if (input.slug && input.slug !== existing.slug) {
    const conflict = await prisma.tenant.findUnique({ where: { slug: input.slug } });
    if (conflict) throw new OrganizationValidationError([`slug "${input.slug}" is already in use`]);
  }

  const updated = await prisma.tenant.update({
    where: { id },
    data: {
      name: input.name,
      slug: input.slug,
      humanReviewSignalEnabled: input.humanReviewSignalEnabled,
      humanReviewSignalThreshold: input.humanReviewSignalThreshold,
      reviewDigestEnabled: input.reviewDigestEnabled,
      reviewDigestIntervalMinutes: input.reviewDigestIntervalMinutes,
      ...(input.assignmentNotifyEnabled !== undefined ? { assignmentNotifyEnabled: input.assignmentNotifyEnabled } : {}),
      ...(input.assignmentNotifyThreshold !== undefined ? { assignmentNotifyThreshold: input.assignmentNotifyThreshold } : {}),
      forwardDailyLimit: input.forwardDailyLimit,
      ...(input.blockDestinationRef !== undefined ? { blockDestinationRef: input.blockDestinationRef?.trim() || null } : {}),
      ...(input.alertEmailsEnabled !== undefined ? { alertEmailsEnabled: input.alertEmailsEnabled } : {}),
      ...(input.alertWebhookUrl !== undefined ? { alertWebhookUrlEncrypted: input.alertWebhookUrl ? encryptSecret(input.alertWebhookUrl) : null } : {}),
      ...(allowedDomains ? { forwardAllowedDomains: allowedDomains.domains } : {}),
      ...(input.bodyRetentionDays !== undefined ? { bodyRetentionDays: input.bodyRetentionDays } : {}),
      ...(input.emailRetentionDays !== undefined ? { emailRetentionDays: input.emailRetentionDays } : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      ...(input.businessHours !== undefined ? { businessHours: input.businessHours === null ? Prisma.DbNull : { ...input.businessHours, days: [...new Set(input.businessHours.days)].sort() } } : {}),
      // Turning digests ON starts the window now — the first digest must not
      // dump the organization's entire review history on everyone at once.
      ...(input.reviewDigestEnabled === true && !existing.reviewDigestEnabled ? { lastReviewDigestAt: new Date() } : {}),
    },
  });
  await recordAuditEvent(prisma, {
    tenantId: id,
    eventType: AuditEventType.ORGANIZATION_UPDATED,
    actor,
    payload: {
      organizationId: id,
      ...(input.humanReviewSignalEnabled !== undefined ? { humanReviewSignalEnabled: input.humanReviewSignalEnabled } : {}),
      ...(input.humanReviewSignalThreshold !== undefined ? { humanReviewSignalThreshold: input.humanReviewSignalThreshold } : {}),
      ...(input.reviewDigestEnabled !== undefined ? { reviewDigestEnabled: input.reviewDigestEnabled } : {}),
      ...(input.reviewDigestIntervalMinutes !== undefined ? { reviewDigestIntervalMinutes: input.reviewDigestIntervalMinutes } : {}),
      ...(input.assignmentNotifyEnabled !== undefined ? { assignmentNotifyEnabled: input.assignmentNotifyEnabled } : {}),
      ...(input.assignmentNotifyThreshold !== undefined ? { assignmentNotifyThreshold: input.assignmentNotifyThreshold } : {}),
      ...(input.forwardDailyLimit !== undefined ? { forwardDailyLimit: input.forwardDailyLimit } : {}),
      ...(input.blockDestinationRef !== undefined ? { blockDestinationRef: input.blockDestinationRef } : {}),
      ...(input.alertEmailsEnabled !== undefined ? { alertEmailsEnabled: input.alertEmailsEnabled } : {}),
      // Never the URL itself (it may carry a token) — only that it changed.
      ...(input.alertWebhookUrl !== undefined ? { alertWebhookConfigured: Boolean(input.alertWebhookUrl) } : {}),
      ...(allowedDomains ? { forwardAllowedDomains: allowedDomains.domains } : {}),
      ...(input.bodyRetentionDays !== undefined ? { bodyRetentionDays: input.bodyRetentionDays } : {}),
      ...(input.emailRetentionDays !== undefined ? { emailRetentionDays: input.emailRetentionDays } : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      ...(input.businessHours !== undefined ? { businessHours: input.businessHours } : {}),
    },
  });
  return updated;
}

/**
 * Soft — sets status="disabled", mirroring every other resource's
 * deactivation convention in this codebase (Rule, DestinationChannel,
 * MailboxConnection). Never a hard delete: an organization that owns
 * mailboxes/rule graphs/destinations/audit history must keep all of that
 * resolvable. Idempotent — deactivating an already-disabled organization is
 * a no-op that still returns it, not an error.
 */
export async function deactivateOrganization(id: string, actor = "system"): Promise<Tenant | null> {
  const existing = await prisma.tenant.findUnique({ where: { id } });
  if (!existing) return null;
  if (existing.status === "disabled") return existing;

  const updated = await prisma.tenant.update({ where: { id }, data: { status: "disabled" } });
  await recordAuditEvent(prisma, {
    tenantId: id,
    eventType: AuditEventType.ORGANIZATION_DEACTIVATED,
    actor,
    payload: { organizationId: id },
  });
  return updated;
}
