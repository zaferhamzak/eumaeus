import type { SystemSettings } from "@prisma/client";
import { redirectUri } from "../../modules/mail-providers/oauth/providers.js";
import { ssoRedirectUri } from "../../modules/auth/sso.js";

export interface SettingsResponse {
  appBaseUrl: string;
  sessionTtlSeconds: number;
  mailboxSyncIntervalSeconds: number;
  rawSourceRetentionDays: number;
  smtpHost: string | null;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername: string | null;
  /** Never the password itself — just whether one is currently set, so the UI can show "•••• (set)" vs an empty field without ever round-tripping the real value. */
  smtpPasswordSet: boolean;
  smtpFromAddress: string | null;
  smtpFromName: string;
  /** Phase 17. Secrets are never returned, only whether one is set. */
  googleOAuthClientId: string | null;
  googleOAuthClientSecretSet: boolean;
  microsoftOAuthClientId: string | null;
  microsoftOAuthClientSecretSet: boolean;
  microsoftOAuthTenant: string;
  /** The exact redirect URIs to register with Google / Microsoft. */
  oauthRedirectUris: { google: string; microsoft: string };
  /** Phase 20. */
  ssoGoogleEnabled: boolean;
  ssoMicrosoftEnabled: boolean;
  ssoAllowedDomains: string[];
  /** Second redirect URIs to register for sign-in (separate from the mailbox ones). */
  ssoRedirectUris: { google: string; microsoft: string };
  updatedAt: string;
  updatedBy: string | null;
}

export function serializeSettings(row: SystemSettings): SettingsResponse {
  return {
    appBaseUrl: row.appBaseUrl,
    sessionTtlSeconds: row.sessionTtlSeconds,
    mailboxSyncIntervalSeconds: row.mailboxSyncIntervalSeconds,
    rawSourceRetentionDays: row.rawSourceRetentionDays,
    smtpHost: row.smtpHost,
    smtpPort: row.smtpPort,
    smtpSecure: row.smtpSecure,
    smtpUsername: row.smtpUsername,
    smtpPasswordSet: row.smtpPasswordEncrypted !== null,
    smtpFromAddress: row.smtpFromAddress,
    smtpFromName: row.smtpFromName,
    googleOAuthClientId: row.googleOAuthClientId,
    googleOAuthClientSecretSet: row.googleOAuthClientSecretEncrypted !== null,
    microsoftOAuthClientId: row.microsoftOAuthClientId,
    microsoftOAuthClientSecretSet: row.microsoftOAuthClientSecretEncrypted !== null,
    microsoftOAuthTenant: row.microsoftOAuthTenant,
    oauthRedirectUris: { google: redirectUri(row.appBaseUrl, "google"), microsoft: redirectUri(row.appBaseUrl, "microsoft") },
    ssoGoogleEnabled: row.ssoGoogleEnabled,
    ssoMicrosoftEnabled: row.ssoMicrosoftEnabled,
    ssoAllowedDomains: row.ssoAllowedDomains,
    ssoRedirectUris: { google: ssoRedirectUri(row.appBaseUrl, "google"), microsoft: ssoRedirectUri(row.appBaseUrl, "microsoft") },
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}
