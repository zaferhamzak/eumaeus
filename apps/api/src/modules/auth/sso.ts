import { createHash, randomBytes } from "node:crypto";
import type { SystemSettings } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { getSessionRedis, type SessionMeta } from "./sessionStore.js";
import { getSystemSettings } from "../settings/systemSettings.js";
import { providerSpec, type OAuthProvider, type ProviderSpec } from "../mail-providers/oauth/providers.js";
import { exchangeCode } from "../mail-providers/oauth/tokens.js";
import { completeExternalLogin, recordSsoRefused, type LoginResult } from "./authService.js";

/**
 * Phase 20: signing in to Eumaeus with Google or Microsoft (OpenID Connect,
 * authorization code + PKCE), reusing the OAuth apps set up for mailboxes in
 * Phase 17 with a sign-in-only scope (openid email profile).
 *
 *   who     only people who already have an active Eumaeus account (created
 *           by an invitation). A pending invitation for that address is
 *           accepted by signing in. SSO never creates accounts.
 *   where   Settings › ssoAllowedDomains, when set, limits the address domain.
 *   MFA     unchanged: an account with MFA still has to enter its code.
 *   binding the one-time state is also set as a short-lived cookie on the
 *           browser that started, and the callback must present both — so
 *           nobody can finish a sign-in they started in someone else's
 *           browser (login CSRF).
 *   token   the ID token comes straight from the provider's token endpoint
 *           over TLS, so its claims are checked (issuer, audience, expiry,
 *           nonce, verified email) rather than its signature — OIDC Core
 *           §3.1.3.7 allows this for the code flow.
 */
const STATE_TTL_SECONDS = 600;
const STATE_PREFIX = "sso_state:";
export const SSO_STATE_COOKIE = "jm_sso_state";

export class SsoError extends Error {}

export function ssoRedirectUri(appBaseUrl: string, provider: OAuthProvider): string {
  return `${appBaseUrl.replace(/\/$/, "")}/api/v1/auth/sso/${provider}/callback`;
}

export function ssoEnabled(provider: OAuthProvider, settings: SystemSettings): boolean {
  const on = provider === "google" ? settings.ssoGoogleEnabled : settings.ssoMicrosoftEnabled;
  if (!on) return false;
  try {
    providerSpec(provider, settings);
    return true;
  } catch {
    return false;
  }
}

function ssoSpec(provider: OAuthProvider, settings: SystemSettings): ProviderSpec {
  if (!ssoEnabled(provider, settings)) throw new SsoError(`Signing in with ${provider === "google" ? "Google" : "Microsoft"} is not turned on.`);
  return { ...providerSpec(provider, settings), scopes: ["openid", "email", "profile"], authorizeParams: { prompt: "select_account" } };
}

interface PendingSso {
  provider: OAuthProvider;
  codeVerifier: string;
  nonce: string;
}

export async function startSso(provider: OAuthProvider): Promise<{ authorizationUrl: string; state: string }> {
  const settings = await getSystemSettings();
  const spec = ssoSpec(provider, settings);
  const state = randomBytes(32).toString("base64url");
  const pending: PendingSso = { provider, codeVerifier: randomBytes(48).toString("base64url"), nonce: randomBytes(16).toString("base64url") };
  await getSessionRedis().set(STATE_PREFIX + state, JSON.stringify(pending), "EX", STATE_TTL_SECONDS);
  const url = new URL(spec.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: spec.clientId,
    response_type: "code",
    redirect_uri: ssoRedirectUri(settings.appBaseUrl, provider),
    scope: spec.scopes.join(" "),
    state,
    nonce: pending.nonce,
    code_challenge: createHash("sha256").update(pending.codeVerifier).digest("base64url"),
    code_challenge_method: "S256",
    ...spec.authorizeParams,
  }).toString();
  return { authorizationUrl: url.toString(), state };
}

export interface IdClaims {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nonce?: unknown;
  email?: unknown;
  email_verified?: unknown;
  preferred_username?: unknown;
}

function decodeClaims(idToken: string | undefined): IdClaims {
  const payload = idToken?.split(".")[1];
  if (!payload) throw new SsoError("The provider didn't return an ID token.");
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as IdClaims;
  } catch {
    throw new SsoError("The provider's ID token could not be read.");
  }
}

/** Checks the ID token's claims and returns the verified email address. */
export function verifiedEmail(provider: OAuthProvider, claims: IdClaims, expected: { clientId: string; nonce: string }, now: Date = new Date()): string {
  const issOk =
    provider === "google"
      ? claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com"
      : typeof claims.iss === "string" && /^https:\/\/login\.microsoftonline\.com\/[^/]+\/v2\.0$/.test(claims.iss);
  const audOk = claims.aud === expected.clientId || (Array.isArray(claims.aud) && claims.aud.includes(expected.clientId));
  if (!issOk || !audOk) throw new SsoError("The sign-in response wasn't issued for this Eumaeus.");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now.getTime()) throw new SsoError("The sign-in response has expired. Try again.");
  if (claims.nonce !== expected.nonce) throw new SsoError("The sign-in response doesn't match this sign-in. Try again.");
  // Google says whether the address is verified; Microsoft work/school
  // accounts don't send the claim, and their addresses are tenant-managed.
  if (provider === "google" && claims.email_verified !== true) throw new SsoError("Google hasn't verified this account's email address.");
  const email = [claims.email, claims.preferred_username].find((v): v is string => typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
  if (!email) throw new SsoError("The provider didn't say which email address signed in.");
  return email.trim().toLowerCase();
}

export async function completeSso(input: { provider: OAuthProvider; code: string; state: string; browserState: string | undefined; meta: SessionMeta }): Promise<LoginResult & { email: string }> {
  if (!input.browserState || input.browserState !== input.state) throw new SsoError("This sign-in was started in a different browser. Start again from the sign-in page.");
  const raw = await getSessionRedis().getdel(STATE_PREFIX + input.state);
  if (!raw) throw new SsoError("This sign-in link has expired or was already used. Start again.");
  const pending = JSON.parse(raw) as PendingSso;
  if (pending.provider !== input.provider) throw new SsoError("The sign-in came back from a different provider than it started with.");

  const settings = await getSystemSettings();
  const spec = ssoSpec(input.provider, settings);
  const tokens = await exchangeCode(spec, input.code, ssoRedirectUri(settings.appBaseUrl, input.provider), pending.codeVerifier);
  const email = verifiedEmail(input.provider, decodeClaims(tokens.idToken), { clientId: spec.clientId, nonce: pending.nonce });

  const domain = email.split("@")[1] ?? "";
  if (settings.ssoAllowedDomains.length > 0 && !settings.ssoAllowedDomains.includes(domain)) {
    await recordSsoRefused(null, { provider: input.provider, reason: "domain_not_allowed", domain });
    throw new SsoError(`Accounts from ${domain} can't sign in to this Eumaeus.`);
  }
  const user = await prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });
  if (!user || user.status !== "active") {
    await recordSsoRefused(user?.id ?? null, { provider: input.provider, reason: user ? "account_disabled" : "no_account", domain });
    throw new SsoError(`There's no Eumaeus account for ${email}. Ask an administrator to invite you.`);
  }

  // Signing in with the invited address accepts its open invitations.
  await prisma.membership.updateMany({
    where: { userId: user.id, status: "pending", inviteExpiresAt: { gt: new Date() } },
    data: { status: "active", acceptedAt: new Date(), inviteTokenHash: null, inviteExpiresAt: null },
  });
  const result = await completeExternalLogin(user.id, `sso_${input.provider}`, input.meta);
  return { ...result, email };
}
