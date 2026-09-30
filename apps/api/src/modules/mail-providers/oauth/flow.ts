import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../../../db/client.js";
import { getSessionRedis } from "../../auth/sessionStore.js";
import { getSystemSettings } from "../../settings/systemSettings.js";
import { recordAuditEvent, AuditEventType } from "../../audit/record.js";
import { scheduleMailboxSync } from "../../../queue/mailboxSyncQueue.js";
import { upsertOAuthMailboxConnection } from "../imap/manageMailboxConnections.js";
import { providerSpec, redirectUri, type OAuthProvider } from "./providers.js";
import { emailFromIdToken, exchangeCode, OAuthError, storeTokens } from "./tokens.js";

/**
 * Connecting a mailbox with Google / Microsoft (Phase 17), authorization code
 * flow with PKCE:
 *
 *   start    -> a one-time `state` (Redis, 10 min) remembering who asked, for
 *               which organization and mailbox, plus the PKCE verifier; the
 *               browser is sent to the provider.
 *   callback -> the state is consumed (single use) and must belong to the
 *               same signed-in user who started it; the code is exchanged,
 *               the account's address read from the ID token, and the mailbox
 *               created (or reconnected) with its tokens.
 */
const STATE_TTL_SECONDS = 600;
const STATE_PREFIX = "oauth_state:";

interface PendingOAuth {
  provider: OAuthProvider;
  tenantId: string;
  userId: string;
  actor: string;
  codeVerifier: string;
  folder: string;
  name?: string;
  mailboxConnectionId?: string;
  /** Where the browser lands afterwards: the organization's page instead of Mailboxes. */
  returnTo?: "organization";
}

export interface StartOAuthInput {
  provider: OAuthProvider;
  tenantId: string;
  userId: string;
  actor: string;
  folder?: string;
  name?: string;
  /** Reconnect this existing mailbox instead of adding a new one. */
  mailboxConnectionId?: string;
  returnTo?: "organization";
}

export async function startOAuth(input: StartOAuthInput): Promise<{ authorizationUrl: string }> {
  const settings = await getSystemSettings();
  const spec = providerSpec(input.provider, settings); // throws OAuthNotConfiguredError
  if (input.mailboxConnectionId) {
    const mailbox = await prisma.mailboxConnection.findFirst({ where: { id: input.mailboxConnectionId, tenantId: input.tenantId } });
    if (!mailbox) throw new OAuthError("not_found", "Mailbox not found");
  }

  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(48).toString("base64url");
  const pending: PendingOAuth = {
    provider: input.provider,
    tenantId: input.tenantId,
    userId: input.userId,
    actor: input.actor,
    codeVerifier,
    folder: input.folder?.trim() || "INBOX",
    ...(input.name ? { name: input.name } : {}),
    ...(input.mailboxConnectionId ? { mailboxConnectionId: input.mailboxConnectionId } : {}),
    ...(input.returnTo ? { returnTo: input.returnTo } : {}),
  };
  await getSessionRedis().set(STATE_PREFIX + state, JSON.stringify(pending), "EX", STATE_TTL_SECONDS);

  const url = new URL(spec.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: spec.clientId,
    response_type: "code",
    redirect_uri: redirectUri(settings.appBaseUrl, input.provider),
    scope: spec.scopes.join(" "),
    state,
    code_challenge: createHash("sha256").update(codeVerifier).digest("base64url"),
    code_challenge_method: "S256",
    ...spec.authorizeParams,
  }).toString();
  return { authorizationUrl: url.toString() };
}

export interface CompleteOAuthResult {
  mailboxConnectionId: string;
  emailAddress: string;
  created: boolean;
}

/**
 * The app path the callback should send the browser back to for this state,
 * read without consuming it (completeOAuth does that). Mailboxes when the
 * state is unknown — the page then shows the error.
 */
export async function returnPathFor(state: string): Promise<string> {
  const raw = await getSessionRedis().get(STATE_PREFIX + state);
  if (!raw) return "/mailboxes";
  const pending = JSON.parse(raw) as PendingOAuth;
  return pending.returnTo === "organization" ? `/organizations/${encodeURIComponent(pending.tenantId)}` : "/mailboxes";
}

export async function completeOAuth(input: { provider: OAuthProvider; code: string; state: string; userId: string }): Promise<CompleteOAuthResult> {
  const redis = getSessionRedis();
  const key = STATE_PREFIX + input.state;
  // GETDEL: a state can be used exactly once, even if the callback is replayed.
  const raw = await redis.getdel(key);
  if (!raw) throw new OAuthError("invalid_state", "This sign-in link has expired or was already used. Start again from Mailboxes.");
  const pending = JSON.parse(raw) as PendingOAuth;
  if (pending.provider !== input.provider) throw new OAuthError("invalid_state", "The sign-in came back from a different provider than it started with.");
  // Binds the callback to the browser session that started it: a link
  // started by someone else can't attach their account to your organization.
  if (pending.userId !== input.userId) throw new OAuthError("invalid_state", "This sign-in was started by a different user.");

  const settings = await getSystemSettings();
  const spec = providerSpec(input.provider, settings);
  const tokens = await exchangeCode(spec, input.code, redirectUri(settings.appBaseUrl, input.provider), pending.codeVerifier);
  const emailAddress = emailFromIdToken(tokens.idToken);
  if (!emailAddress) throw new OAuthError("no_email", "The provider didn't say which email address was signed in.");

  const { mailbox, created } = await upsertOAuthMailboxConnection(pending.tenantId, {
    authType: spec.authType,
    emailAddress,
    name: pending.name,
    folder: pending.folder,
    imap: spec.imap,
    mailboxConnectionId: pending.mailboxConnectionId,
  });
  await storeTokens(pending.tenantId, mailbox.id, input.provider, tokens);
  await scheduleMailboxSync(mailbox.id, settings.mailboxSyncIntervalSeconds * 1000);
  await recordAuditEvent(prisma, {
    tenantId: pending.tenantId,
    eventType: AuditEventType.MAILBOX_OAUTH_CONNECTED,
    actor: pending.actor,
    payload: { mailboxConnectionId: mailbox.id, provider: input.provider, emailAddress, reconnected: !created },
  });
  return { mailboxConnectionId: mailbox.id, emailAddress, created };
}
