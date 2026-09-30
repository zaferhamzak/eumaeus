import { apiRequest } from "./client";
import type { SettingsResponse } from "@/types/api";

export function getSettings(signal?: AbortSignal) {
  return apiRequest<SettingsResponse>("/api/v1/settings", { signal });
}

export interface UpdateSettingsInput {
  appBaseUrl?: string;
  sessionTtlSeconds?: number;
  mailboxSyncIntervalSeconds?: number;
  rawSourceRetentionDays?: number;
  smtpHost?: string | null;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUsername?: string | null;
  /** Omitted = unchanged, "" = clear the stored password, non-empty = replace it. */
  smtpPassword?: string;
  smtpFromAddress?: string | null;
  smtpFromName?: string;
  googleOAuthClientId?: string | null;
  /** Omitted = unchanged, "" = clear, otherwise replace. */
  googleOAuthClientSecret?: string;
  microsoftOAuthClientId?: string | null;
  microsoftOAuthClientSecret?: string;
  microsoftOAuthTenant?: string;
  ssoGoogleEnabled?: boolean;
  ssoMicrosoftEnabled?: boolean;
  ssoAllowedDomains?: string[];
  /** Save a port/TLS combination the backend flags as unusual anyway. */
  confirmUnusualTls?: boolean;
}

export interface SmtpTestResult {
  ok: boolean;
  to: string;
  errorClass?: string;
  message?: string;
  hint?: string;
}

export function testSmtp(to?: string) {
  return apiRequest<SmtpTestResult>("/api/v1/settings/smtp-test", {
    method: "POST",
    body: to ? { to } : {},
  });
}

export function updateSettings(input: UpdateSettingsInput) {
  return apiRequest<SettingsResponse>("/api/v1/settings", {
    method: "PATCH",
    body: input,
  });
}
