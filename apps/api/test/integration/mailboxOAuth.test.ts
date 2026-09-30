import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/db/client.js";
import { updateSystemSettings } from "../../src/modules/settings/systemSettings.js";
import { startOAuth, completeOAuth } from "../../src/modules/mail-providers/oauth/flow.js";
import { getFreshAccessToken, emailFromIdToken, MailboxReauthRequiredError, OAuthError } from "../../src/modules/mail-providers/oauth/tokens.js";
import { OAuthNotConfiguredError } from "../../src/modules/mail-providers/oauth/providers.js";
import { MailboxValidationError } from "../../src/modules/mail-providers/imap/manageMailboxConnections.js";
import { syncMailbox } from "../../src/modules/mail-providers/imap/sync.js";
import { FakeImapClient } from "../fixtures/fakeImapClient.js";
import { resetDatabase } from "../helpers/db.js";

function idToken(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

/** A fake token endpoint: every POST gets the next scripted response; requests are recorded. */
function fakeProvider(responses: Array<{ status: number; body: Record<string, unknown> } | Error>) {
  const requests: Array<{ url: string; params: URLSearchParams }> = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, params: new URLSearchParams(String(init.body)) });
    const next = responses.shift();
    if (!next) throw new Error("unexpected token request");
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requests, fetchMock };
}

const TOKENS = (email: string, extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: "https://mail.google.com/", id_token: idToken({ email }), ...extra },
});

async function setup() {
  const tenant = await prisma.tenant.create({ data: { name: "Acme" } });
  await updateSystemSettings({ appBaseUrl: "https://jev.acme.test", googleOAuthClientId: "client-123", googleOAuthClientSecret: "shh", microsoftOAuthClientId: "ms-app", microsoftOAuthClientSecret: "ms-shh" }, "admin");
  return tenant;
}

async function connect(tenantId: string, email = "ops@acme.test", extra: { mailboxConnectionId?: string } = {}) {
  const { authorizationUrl } = await startOAuth({ provider: "google", tenantId, userId: "user-1", actor: "admin@acme.test", ...extra });
  const state = new URL(authorizationUrl).searchParams.get("state")!;
  fakeProvider([TOKENS(email)]);
  return { state, result: await completeOAuth({ provider: "google", code: "code-1", state, userId: "user-1" }) };
}

describe("mailbox OAuth (Phase 17)", () => {
  beforeEach(resetDatabase);
  afterEach(() => vi.unstubAllGlobals());

  it("builds a PKCE authorization URL with the registered redirect URI", async () => {
    const tenant = await setup();
    const { authorizationUrl } = await startOAuth({ provider: "google", tenantId: tenant.id, userId: "user-1", actor: "a" });
    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "client-123",
      redirect_uri: "https://jev.acme.test/api/v1/mailboxes/oauth/google/callback",
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      scope: "https://mail.google.com/ openid email",
    });
    expect(url.searchParams.get("state")).toHaveLength(43);
  });

  it("refuses to start when the provider isn't set up", async () => {
    const tenant = await prisma.tenant.create({ data: { name: "Acme" } });
    await expect(startOAuth({ provider: "microsoft", tenantId: tenant.id, userId: "u", actor: "a" })).rejects.toBeInstanceOf(OAuthNotConfiguredError);
  });

  it("the callback creates a Gmail mailbox with encrypted tokens, using the PKCE verifier", async () => {
    const tenant = await setup();
    const { authorizationUrl } = await startOAuth({ provider: "google", tenantId: tenant.id, userId: "user-1", actor: "admin@acme.test", folder: "INBOX" });
    const url = new URL(authorizationUrl);
    const { requests } = fakeProvider([TOKENS("Ops@Acme.test")]);

    const result = await completeOAuth({ provider: "google", code: "code-1", state: url.searchParams.get("state")!, userId: "user-1" });

    expect(result).toMatchObject({ emailAddress: "ops@acme.test", created: true });
    expect(requests[0]!.params.get("grant_type")).toBe("authorization_code");
    expect(requests[0]!.params.get("code_verifier")).toBeTruthy();
    const mailbox = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: result.mailboxConnectionId }, include: { oauthToken: true, credential: true } });
    expect(mailbox).toMatchObject({ authType: "oauth_google", status: "active", emailAddress: "ops@acme.test", providerConfig: { host: "imap.gmail.com", port: 993, tls: true, folder: "INBOX", username: "ops@acme.test" } });
    expect(mailbox.credential).toBeNull();
    expect(mailbox.oauthToken!.refreshTokenEncrypted).not.toContain("refresh-1");
    expect(await prisma.auditEvent.count({ where: { eventType: "mailbox_oauth_connected", actor: "admin@acme.test" } })).toBe(1);
  });

  it("a state works once, and only for the user who started it", async () => {
    const tenant = await setup();
    const { state } = await connect(tenant.id);
    await expect(completeOAuth({ provider: "google", code: "c", state, userId: "user-1" })).rejects.toMatchObject({ code: "invalid_state" });

    const { authorizationUrl } = await startOAuth({ provider: "google", tenantId: tenant.id, userId: "user-1", actor: "a" });
    const other = new URL(authorizationUrl).searchParams.get("state")!;
    await expect(completeOAuth({ provider: "google", code: "c", state: other, userId: "intruder" })).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("reconnecting a mailbox needing re-auth reactivates it; signing in as another account is refused", async () => {
    const tenant = await setup();
    const { result } = await connect(tenant.id);
    await prisma.mailboxConnection.update({ where: { id: result.mailboxConnectionId }, data: { status: "reauth_required" } });

    const again = await connect(tenant.id, "ops@acme.test", { mailboxConnectionId: result.mailboxConnectionId });
    expect(again.result).toMatchObject({ created: false, mailboxConnectionId: result.mailboxConnectionId });
    expect((await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: result.mailboxConnectionId } })).status).toBe("active");
    expect(await prisma.mailboxConnection.count()).toBe(1);

    await expect(connect(tenant.id, "someone-else@acme.test", { mailboxConnectionId: result.mailboxConnectionId })).rejects.toBeInstanceOf(MailboxValidationError);
  });

  it("uses the stored token while fresh, refreshes it near expiry, and keeps Google's refresh token", async () => {
    const tenant = await setup();
    const { result } = await connect(tenant.id);
    const { fetchMock } = fakeProvider([]);
    expect(await getFreshAccessToken(result.mailboxConnectionId)).toBe("access-1");
    expect(fetchMock).not.toHaveBeenCalled();

    const { requests } = fakeProvider([{ status: 200, body: { access_token: "access-2", expires_in: 3600 } }]);
    const later = new Date(Date.now() + 58 * 60_000);
    expect(await getFreshAccessToken(result.mailboxConnectionId, later)).toBe("access-2");
    expect(requests[0]!.params.get("grant_type")).toBe("refresh_token");
    expect(requests[0]!.params.get("refresh_token")).toBe("refresh-1");
  });

  it("a revoked grant marks the mailbox reauth_required; a network failure does not", async () => {
    const tenant = await setup();
    const { result } = await connect(tenant.id);
    const later = new Date(Date.now() + 2 * 60 * 60_000);

    fakeProvider([new TypeError("fetch failed")]);
    await expect(getFreshAccessToken(result.mailboxConnectionId, later)).rejects.toMatchObject({ code: "network" });
    expect((await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: result.mailboxConnectionId } })).status).toBe("active");

    fakeProvider([{ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }]);
    await expect(getFreshAccessToken(result.mailboxConnectionId, later)).rejects.toBeInstanceOf(MailboxReauthRequiredError);
    const mailbox = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: result.mailboxConnectionId } });
    expect(mailbox.status).toBe("reauth_required");
    expect(mailbox.lastSyncError).toContain("revoked");
  });

  it("sync signs in with the access token (XOAUTH2), not a password", async () => {
    const tenant = await setup();
    const { result } = await connect(tenant.id);
    let usedSecret = "";
    await syncMailbox(result.mailboxConnectionId, (_config, secret) => {
      usedSecret = secret;
      return new FakeImapClient({ uidValidity: 1, uidNext: 1, messages: [] });
    });
    expect(usedSecret).toBe("access-1");
  });

  it("reads the address from Google's email or Microsoft's preferred_username", () => {
    expect(emailFromIdToken(idToken({ email: "A@B.test" }))).toBe("a@b.test");
    expect(emailFromIdToken(idToken({ preferred_username: "x@contoso.test" }))).toBe("x@contoso.test");
    expect(emailFromIdToken("garbage")).toBeNull();
    expect(OAuthError).toBeDefined();
  });
});
