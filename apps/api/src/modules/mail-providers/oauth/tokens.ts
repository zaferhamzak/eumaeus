import { prisma } from "../../../db/client.js";
import { decryptSecret, encryptSecret } from "../../secrets/secretCrypto.js";
import { getSystemSettings } from "../../settings/systemSettings.js";
import { recordAuditEvent, AuditEventType } from "../../audit/record.js";
import { unscheduleMailboxSync } from "../../../queue/mailboxSyncQueue.js";
import { providerForAuthType, providerSpec, type ProviderSpec } from "./providers.js";

/**
 * Token exchange and refresh against the provider's token endpoint (Phase 17).
 * Plain fetch with a timeout — two POSTs don't justify an OAuth library.
 */
const HTTP_TIMEOUT_MS = 15_000;
/** Refresh this long before expiry, so a sync never starts with a token that dies mid-session. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export class OAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The refresh token no longer works (revoked, password changed, consent removed). Only a person signing in again fixes it. */
export class MailboxReauthRequiredError extends Error {}

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds: number;
  scope?: string;
  idToken?: string;
}

async function postForm(url: string, params: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  } catch (error) {
    // Network failure or timeout: transient, never a verdict on the sign-in.
    throw new OAuthError("network", `Could not reach the sign-in provider: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

function parseTokenResponse(body: Record<string, unknown>): TokenResponse {
  if (typeof body.access_token !== "string") throw new OAuthError("invalid_response", "The provider did not return an access token");
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    expiresInSeconds: typeof body.expires_in === "number" ? body.expires_in : Number(body.expires_in ?? 3600),
    scope: typeof body.scope === "string" ? body.scope : undefined,
    idToken: typeof body.id_token === "string" ? body.id_token : undefined,
  };
}

function providerError(body: Record<string, unknown>, fallback: string): OAuthError {
  const code = typeof body.error === "string" ? body.error : "provider_error";
  const description = typeof body.error_description === "string" ? body.error_description : fallback;
  return new OAuthError(code, description);
}

export async function exchangeCode(spec: ProviderSpec, code: string, redirectUri: string, codeVerifier: string): Promise<TokenResponse> {
  const { status, body } = await postForm(spec.tokenUrl, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: spec.clientId,
    client_secret: spec.clientSecret,
    code_verifier: codeVerifier,
  });
  if (status !== 200) throw providerError(body, "The sign-in code could not be exchanged");
  return parseTokenResponse(body);
}

/**
 * The account's email address from the ID token. The token came straight from
 * the provider's token endpoint over TLS in exchange for our own code, so
 * OIDC allows using its claims without verifying the signature.
 */
export function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const email = [claims.email, claims.preferred_username, claims.upn].find((v): v is string => typeof v === "string" && v.includes("@"));
    return email ? email.toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function storeTokens(tenantId: string, mailboxConnectionId: string, provider: string, tokens: TokenResponse, previousRefreshToken?: string): Promise<void> {
  const refreshToken = tokens.refreshToken ?? previousRefreshToken;
  if (!refreshToken) throw new OAuthError("no_refresh_token", "The provider did not grant offline access. Remove Eumaeus's access in your account settings and connect again.");
  const data = {
    tenantId,
    provider,
    refreshTokenEncrypted: encryptSecret(refreshToken),
    accessTokenEncrypted: encryptSecret(tokens.accessToken),
    accessTokenExpiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
    scope: tokens.scope ?? null,
  };
  await prisma.mailboxOAuthToken.upsert({ where: { mailboxConnectionId }, create: { mailboxConnectionId, ...data }, update: data });
}

/**
 * A usable access token for an OAuth mailbox, refreshed if it expires within
 * REFRESH_MARGIN_MS. A refresh the provider refuses with invalid_grant means
 * the grant is gone: the mailbox moves to "reauth_required", its sync is
 * unscheduled (it can't succeed), and MailboxReauthRequiredError is thrown.
 * Any other failure (network, 5xx) is thrown as a plain OAuthError, and the
 * caller's normal retry applies.
 */
export async function getFreshAccessToken(mailboxConnectionId: string, now: Date = new Date()): Promise<string> {
  const mailbox = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: mailboxConnectionId }, include: { oauthToken: true } });
  const provider = providerForAuthType(mailbox.authType);
  const token = mailbox.oauthToken;
  if (!provider || !token) throw new MailboxReauthRequiredError(`Mailbox ${mailbox.emailAddress} has no OAuth sign-in; connect it again`);

  if (token.accessTokenEncrypted && token.accessTokenExpiresAt && token.accessTokenExpiresAt.getTime() - now.getTime() > REFRESH_MARGIN_MS) {
    return decryptSecret(token.accessTokenEncrypted);
  }

  const spec = providerSpec(provider, await getSystemSettings());
  const previousRefreshToken = decryptSecret(token.refreshTokenEncrypted);
  const { status, body } = await postForm(spec.tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: previousRefreshToken,
    client_id: spec.clientId,
    client_secret: spec.clientSecret,
  });
  if (status !== 200) {
    const error = providerError(body, "The access token could not be refreshed");
    if (error.code === "invalid_grant") {
      await markReauthRequired(mailbox.tenantId, mailbox.id, error.message);
      throw new MailboxReauthRequiredError(`Sign-in for ${mailbox.emailAddress} has expired or was revoked; connect it again`);
    }
    throw error;
  }
  const refreshed = parseTokenResponse(body);
  // Microsoft rotates refresh tokens; Google keeps the old one (omits it).
  await storeTokens(mailbox.tenantId, mailbox.id, token.provider, refreshed, previousRefreshToken);
  return refreshed.accessToken;
}

async function markReauthRequired(tenantId: string, mailboxConnectionId: string, reason: string): Promise<void> {
  await prisma.mailboxConnection.update({ where: { id: mailboxConnectionId }, data: { status: "reauth_required", lastSyncError: `Sign-in expired: ${reason}` } });
  await unscheduleMailboxSync(mailboxConnectionId);
  await recordAuditEvent(prisma, { tenantId, eventType: AuditEventType.MAILBOX_REAUTH_REQUIRED, actor: "system", payload: { mailboxConnectionId, reason } });
}
