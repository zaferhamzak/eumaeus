import type { SystemSettings } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { loadEnv } from "../../config/env.js";
import { encryptSecret, decryptSecret } from "../secrets/secretCrypto.js";

/**
 * The single UI-editable settings row (Phase 11.2) — see schema.prisma's
 * SystemSettings header comment for the full "why this, why not env vars,
 * why not X" reasoning. This module owns the find-or-create idiom
 * (seeded from env.ts's current values on first read, exactly once) and a
 * short in-process cache so per-request callers (sessionStore.ts's
 * refreshSession, called on EVERY authenticated request) don't hit the
 * database on every single call — a 30s staleness window is a deliberate
 * trade-off, not an oversight: settings changes are rare, human-driven
 * admin actions, not something that needs sub-second propagation.
 */
const CACHE_TTL_MS = 30_000;
let cached: { value: SystemSettings; expiresAt: number } | undefined;

async function findOrCreate(): Promise<SystemSettings> {
  const existing = await prisma.systemSettings.findFirst();
  if (existing) return existing;

  // First-ever read: seed from the current env vars, exactly once — mirrors
  // ensureBootstrapAdminUser's idempotent-seed pattern. A concurrent racing
  // create (two requests both finding no row) is handled by just taking
  // whichever committed first; the loser's insert would violate no unique
  // constraint here (there's no natural key), so instead re-query.
  const env = loadEnv();
  try {
    return await prisma.systemSettings.create({
      data: {
        appBaseUrl: env.APP_BASE_URL,
        sessionTtlSeconds: env.SESSION_TTL_SECONDS,
        mailboxSyncIntervalSeconds: env.MAIL_SYNC_INTERVAL_SECONDS,
        smtpHost: env.SMTP_HOST ?? null,
        smtpPort: env.SMTP_PORT,
        smtpSecure: env.SMTP_SECURE,
        smtpUsername: env.SMTP_USERNAME ?? null,
        smtpPasswordEncrypted: env.SMTP_PASSWORD ? encryptSecret(env.SMTP_PASSWORD) : null,
        smtpFromAddress: env.SMTP_FROM_ADDRESS ?? null,
        smtpFromName: env.SMTP_FROM_NAME,
      },
    });
  } catch {
    const raced = await prisma.systemSettings.findFirst();
    if (raced) return raced;
    throw new Error("SystemSettings could not be created or found");
  }
}

export async function getSystemSettings(): Promise<SystemSettings> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await findOrCreate();
  cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

/** Test-only: forces the next getSystemSettings() call to hit the database instead of a stale cached value from an earlier test. */
export function clearSystemSettingsCache(): void {
  cached = undefined;
}

/** The ONE place SMTP's plaintext password is resolved — mirrors resolveMailboxPassword()/resolveDestinationSecretPlaintext()'s exact contract: called only immediately before use (modules/email/mailer.ts), never retained beyond that one call. */
export async function resolveSmtpPassword(): Promise<string | null> {
  const settings = await getSystemSettings();
  return settings.smtpPasswordEncrypted ? decryptSecret(settings.smtpPasswordEncrypted) : null;
}

export class SettingsValidationError extends Error {}

/**
 * The classic SMTP misconfiguration: 587 expects STARTTLS (secure off), 465
 * expects implicit TLS (secure on). Getting it backwards fails every send
 * with an opaque TLS "wrong version number" error. Other ports aren't
 * checked — they have no fixed convention.
 */
export function smtpTlsMismatch(port: number, secure: boolean): string | null {
  if (port === 587 && secure) return 'Port 587 uses STARTTLS: turn "implicit TLS" off, or use port 465.';
  if (port === 465 && !secure) return 'Port 465 uses implicit TLS: turn "implicit TLS" on, or use port 587.';
  return null;
}

export interface UpdateSystemSettingsInput {
  appBaseUrl?: string;
  sessionTtlSeconds?: number;
  mailboxSyncIntervalSeconds?: number;
  rawSourceRetentionDays?: number;
  smtpHost?: string | null;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUsername?: string | null;
  /** Omitted = leave unchanged. Empty string = clear it. Non-empty = re-encrypt and replace. Never the encrypted form — always plaintext in, immediately encrypted here. */
  smtpPassword?: string;
  smtpFromAddress?: string | null;
  smtpFromName?: string;
  /** Phase 17. Secrets follow the SMTP password's rule: omitted = unchanged, "" = clear, otherwise re-encrypted. */
  googleOAuthClientId?: string | null;
  googleOAuthClientSecret?: string;
  microsoftOAuthClientId?: string | null;
  microsoftOAuthClientSecret?: string;
  microsoftOAuthTenant?: string;
  /** Phase 20: sign-in to Eumaeus with Google / Microsoft. */
  ssoGoogleEnabled?: boolean;
  ssoMicrosoftEnabled?: boolean;
  ssoAllowedDomains?: string[];
  /** Save a port/TLS combination smtpTlsMismatch() flags anyway (a server that really does it differently). Not stored. */
  confirmUnusualTls?: boolean;
}

export async function updateSystemSettings(input: UpdateSystemSettingsInput, actor: string | undefined): Promise<SystemSettings> {
  const current = await getSystemSettings();

  const host = input.smtpHost !== undefined ? input.smtpHost : current.smtpHost;
  const mismatch = smtpTlsMismatch(input.smtpPort ?? current.smtpPort, input.smtpSecure ?? current.smtpSecure);
  // Only checked when this save touches SMTP transport settings — an unrelated
  // change (session lifetime, say) must not be blocked by an old SMTP setup.
  const touchesTransport = input.smtpHost !== undefined || input.smtpPort !== undefined || input.smtpSecure !== undefined;
  if (host && mismatch && touchesTransport && !input.confirmUnusualTls) throw new SettingsValidationError(mismatch);

  let ssoDomains: string[] | undefined;
  if (input.ssoAllowedDomains !== undefined) {
    ssoDomains = [...new Set(input.ssoAllowedDomains.map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))];
    const bad = ssoDomains.filter((d) => !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d));
    if (bad.length > 0) throw new SettingsValidationError(`Not a valid domain: ${bad.join(", ")}`);
  }
  for (const [flag, provider] of [["ssoGoogleEnabled", "google"], ["ssoMicrosoftEnabled", "microsoft"]] as const) {
    const clientId = provider === "google" ? (input.googleOAuthClientId !== undefined ? input.googleOAuthClientId : current.googleOAuthClientId) : input.microsoftOAuthClientId !== undefined ? input.microsoftOAuthClientId : current.microsoftOAuthClientId;
    if (input[flag] === true && !clientId?.trim()) throw new SettingsValidationError(`Set up the ${provider === "google" ? "Google" : "Microsoft"} app first (client id and secret), then turn on sign-in with it`);
  }

  const passwordUpdate =
    input.smtpPassword === undefined
      ? {}
      : input.smtpPassword === ""
        ? { smtpPasswordEncrypted: null }
        : { smtpPasswordEncrypted: encryptSecret(input.smtpPassword) };

  const secretUpdate = (value: string | undefined, field: "googleOAuthClientSecretEncrypted" | "microsoftOAuthClientSecretEncrypted") =>
    value === undefined ? {} : { [field]: value === "" ? null : encryptSecret(value) };

  const updated = await prisma.systemSettings.update({
    where: { id: current.id },
    data: {
      ...(input.googleOAuthClientId !== undefined ? { googleOAuthClientId: input.googleOAuthClientId?.trim() || null } : {}),
      ...secretUpdate(input.googleOAuthClientSecret, "googleOAuthClientSecretEncrypted"),
      ...(input.microsoftOAuthClientId !== undefined ? { microsoftOAuthClientId: input.microsoftOAuthClientId?.trim() || null } : {}),
      ...secretUpdate(input.microsoftOAuthClientSecret, "microsoftOAuthClientSecretEncrypted"),
      ...(input.microsoftOAuthTenant !== undefined ? { microsoftOAuthTenant: input.microsoftOAuthTenant.trim() || "common" } : {}),
      ...(input.ssoGoogleEnabled !== undefined ? { ssoGoogleEnabled: input.ssoGoogleEnabled } : {}),
      ...(input.ssoMicrosoftEnabled !== undefined ? { ssoMicrosoftEnabled: input.ssoMicrosoftEnabled } : {}),
      ...(ssoDomains ? { ssoAllowedDomains: ssoDomains } : {}),
      ...(input.appBaseUrl !== undefined ? { appBaseUrl: input.appBaseUrl } : {}),
      ...(input.sessionTtlSeconds !== undefined ? { sessionTtlSeconds: input.sessionTtlSeconds } : {}),
      ...(input.mailboxSyncIntervalSeconds !== undefined ? { mailboxSyncIntervalSeconds: input.mailboxSyncIntervalSeconds } : {}),
      ...(input.rawSourceRetentionDays !== undefined ? { rawSourceRetentionDays: input.rawSourceRetentionDays } : {}),
      ...(input.smtpHost !== undefined ? { smtpHost: input.smtpHost } : {}),
      ...(input.smtpPort !== undefined ? { smtpPort: input.smtpPort } : {}),
      ...(input.smtpSecure !== undefined ? { smtpSecure: input.smtpSecure } : {}),
      ...(input.smtpUsername !== undefined ? { smtpUsername: input.smtpUsername } : {}),
      ...passwordUpdate,
      ...(input.smtpFromAddress !== undefined ? { smtpFromAddress: input.smtpFromAddress } : {}),
      ...(input.smtpFromName !== undefined ? { smtpFromName: input.smtpFromName } : {}),
      updatedBy: actor ?? null,
    },
  });

  clearSystemSettingsCache();
  return updated;
}
