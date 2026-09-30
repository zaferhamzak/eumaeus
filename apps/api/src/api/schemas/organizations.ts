import { z } from "zod";

const slugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'slug must be lowercase alphanumeric segments separated by single hyphens (e.g. "acme-security")');

export const createOrganizationBodySchema = z
  .object({
    name: z.string().min(1),
    slug: slugSchema,
  })
  .strict();

export const updateOrganizationBodySchema = z
  .object({
    name: z.string().min(1).optional(),
    slug: slugSchema.optional(),
    humanReviewSignalEnabled: z.boolean().optional(),
    humanReviewSignalThreshold: z.number().min(0).max(1).optional(),
    reviewDigestEnabled: z.boolean().optional(),
    reviewDigestIntervalMinutes: z.number().int().min(5).max(10080).optional(),
    assignmentNotifyEnabled: z.boolean().optional(),
    assignmentNotifyThreshold: z.number().int().min(1).max(100).optional(),
    forwardDailyLimit: z.number().int().min(0).max(10000).optional(),
    blockDestinationRef: z.string().max(200).nullable().optional(),
    alertEmailsEnabled: z.boolean().optional(),
    alertWebhookUrl: z.string().max(2000).nullable().optional(),
    forwardAllowedDomains: z.array(z.string()).max(100).optional(),
    bodyRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
    emailRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
    locale: z.enum(["en", "tr"]).optional(),
    // Phase 22: { timeZone, days: [1..7], start: "HH:MM", end: "HH:MM" } or null.
    businessHours: z
      .object({ timeZone: z.string().max(64), days: z.array(z.number().int()).max(7), start: z.string().max(5), end: z.string().max(5) })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export type CreateOrganizationBody = z.infer<typeof createOrganizationBodySchema>;
export type UpdateOrganizationBody = z.infer<typeof updateOrganizationBodySchema>;
