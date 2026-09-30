import type { SystemSettings } from "@prisma/client";
import { decryptSecret } from "../../secrets/secretCrypto.js";

/**
 * Phase 17: the two OAuth providers a mailbox can be connected with, and the
 * IMAP endpoint each one's mail lives at. The client id/secret come from the
 * Settings page (SystemSettings), not env vars, so they can be entered after
 * the Google Cloud / Azure registration without a restart.
 */
export const OAUTH_PROVIDERS = ["google", "microsoft"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function isOAuthProvider(value: string): value is OAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

export interface ProviderSpec {
  provider: OAuthProvider;
  authType: "oauth_google" | "oauth_microsoft";
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Extra query parameters on the authorization URL. */
  authorizeParams: Record<string, string>;
  imap: { host: string; port: number; tls: boolean };
  clientId: string;
  clientSecret: string;
}

export class OAuthNotConfiguredError extends Error {}

export function providerSpec(provider: OAuthProvider, settings: SystemSettings): ProviderSpec {
  if (provider === "google") {
    if (!settings.googleOAuthClientId || !settings.googleOAuthClientSecretEncrypted) throw new OAuthNotConfiguredError("Google sign-in is not set up yet (Settings › Mailbox sign-in)");
    return {
      provider,
      authType: "oauth_google",
      label: "Google",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      // https://mail.google.com/ is the only Gmail scope that allows IMAP.
      scopes: ["https://mail.google.com/", "openid", "email"],
      // offline + consent: Google only returns a refresh token on consent.
      authorizeParams: { access_type: "offline", prompt: "consent" },
      imap: { host: "imap.gmail.com", port: 993, tls: true },
      clientId: settings.googleOAuthClientId,
      clientSecret: decryptSecret(settings.googleOAuthClientSecretEncrypted),
    };
  }
  if (!settings.microsoftOAuthClientId || !settings.microsoftOAuthClientSecretEncrypted) throw new OAuthNotConfiguredError("Microsoft sign-in is not set up yet (Settings › Mailbox sign-in)");
  const tenant = encodeURIComponent(settings.microsoftOAuthTenant || "common");
  return {
    provider,
    authType: "oauth_microsoft",
    label: "Microsoft",
    authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    scopes: ["https://outlook.office.com/IMAP.AccessAsUser.All", "offline_access", "openid", "email"],
    authorizeParams: { prompt: "select_account" },
    imap: { host: "outlook.office365.com", port: 993, tls: true },
    clientId: settings.microsoftOAuthClientId,
    clientSecret: decryptSecret(settings.microsoftOAuthClientSecretEncrypted),
  };
}

export function redirectUri(appBaseUrl: string, provider: OAuthProvider): string {
  return `${appBaseUrl.replace(/\/$/, "")}/api/v1/mailboxes/oauth/${provider}/callback`;
}

export function providerForAuthType(authType: string): OAuthProvider | null {
  if (authType === "oauth_google") return "google";
  if (authType === "oauth_microsoft") return "microsoft";
  return null;
}
