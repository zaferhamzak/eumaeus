import { z } from "zod";

export const updateSettingsBodySchema = z
  .object({
    appBaseUrl: z.string().min(1).optional(),
    sessionTtlSeconds: z.coerce.number().int().positive().optional(),
    mailboxSyncIntervalSeconds: z.coerce.number().int().positive().optional(),
    // 0 = don't keep raw sources at all; capped at a year.
    rawSourceRetentionDays: z.coerce.number().int().min(0).max(365).optional(),
    smtpHost: z.string().nullable().optional(),
    smtpPort: z.coerce.number().int().positive().optional(),
    smtpSecure: z.boolean().optional(),
    smtpUsername: z.string().nullable().optional(),
    // "" clears the stored password, a non-empty string replaces it, omitted leaves it unchanged — see modules/settings/systemSettings.ts's updateSystemSettings().
    smtpPassword: z.string().optional(),
    // null clears it, a valid email sets it, omitted leaves it unchanged.
    smtpFromAddress: z.string().email().nullable().optional(),
    smtpFromName: z.string().min(1).optional(),
    confirmUnusualTls: z.boolean().optional(),
    googleOAuthClientId: z.string().max(300).nullable().optional(),
    googleOAuthClientSecret: z.string().max(500).optional(),
    microsoftOAuthClientId: z.string().max(300).nullable().optional(),
    microsoftOAuthClientSecret: z.string().max(500).optional(),
    // "common", "organizations", "consumers", or an Azure tenant id / domain.
    microsoftOAuthTenant: z.string().regex(/^[A-Za-z0-9.-]{0,100}$/).optional(),
    ssoGoogleEnabled: z.boolean().optional(),
    ssoMicrosoftEnabled: z.boolean().optional(),
    ssoAllowedDomains: z.array(z.string().max(253)).max(50).optional(),
  })
  .strict();

export type UpdateSettingsBody = z.infer<typeof updateSettingsBodySchema>;
