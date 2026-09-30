import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../src/api/server.js";
import { createTestMembership, createTestUser } from "../helpers/auth.js";
import { resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/db/client.js";
import { updateSystemSettings } from "../../src/modules/settings/systemSettings.js";
import type { Permission } from "../../src/modules/auth/permissions.js";

function idToken(email: string) {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ email })}.x`;
}

async function setup(permissions: Permission[] = ["mailboxes:read", "mailboxes:write"]) {
  const tenant = await prisma.tenant.create({ data: { name: "Acme" } });
  await updateSystemSettings({ appBaseUrl: "https://jev.acme.test", googleOAuthClientId: "client-123", googleOAuthClientSecret: "shh" }, "admin");
  const user = await createTestUser();
  await createTestMembership(user.id, tenant.id, permissions);
  const principal = { id: user.id, email: user.email, isSuperAdmin: false };
  const app = buildServer({ logger: false, authResolver: async () => principal });
  const anonymous = buildServer({ logger: false, authResolver: async () => null });
  return { tenant, app, anonymous, headers: { "x-organization-id": tenant.id } };
}

describe("mailbox OAuth routes (Phase 17)", () => {
  beforeEach(resetDatabase);
  afterEach(() => vi.unstubAllGlobals());

  it("lists which providers are set up", async () => {
    const { app, headers } = await setup();
    const res = await app.inject({ method: "GET", url: "/api/v1/mailboxes/oauth/providers", headers });
    expect(res.json()).toEqual({ google: true, microsoft: false });
  });

  it("start needs mailboxes:write; an unset provider is a clear 400", async () => {
    const readOnly = await setup(["mailboxes:read"]);
    expect((await readOnly.app.inject({ method: "POST", url: "/api/v1/mailboxes/oauth/google/start", headers: readOnly.headers, payload: {} })).statusCode).toBe(403);
  });

  it("full round trip: start, provider redirect back, mailbox connected", async () => {
    const { app, headers } = await setup();
    const start = await app.inject({ method: "POST", url: "/api/v1/mailboxes/oauth/google/start", headers, payload: { folder: "INBOX" } });
    expect(start.statusCode).toBe(200);
    const state = new URL(start.json().authorizationUrl).searchParams.get("state")!;
    expect((await app.inject({ method: "POST", url: "/api/v1/mailboxes/oauth/microsoft/start", headers, payload: {} })).statusCode).toBe(400);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600, id_token: idToken("ops@acme.test") }), { status: 200 })));
    const callback = await app.inject({ method: "GET", url: `/api/v1/mailboxes/oauth/google/callback?code=abc&state=${state}` });

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("https://jev.acme.test/mailboxes?connected=ops%40acme.test");
    const mailboxes = (await app.inject({ method: "GET", url: "/api/v1/mailboxes", headers })).json().data;
    expect(mailboxes[0]).toMatchObject({ emailAddress: "ops@acme.test", authType: "oauth_google", host: "imap.gmail.com" });

    const patch = await app.inject({ method: "PATCH", url: `/api/v1/mailboxes/${mailboxes[0].id}`, headers, payload: { password: "nope" } });
    expect(patch.statusCode).toBe(400);
  });

  it("started from an organization's page, the callback returns there", async () => {
    const { app, headers, tenant } = await setup();
    const start = await app.inject({ method: "POST", url: "/api/v1/mailboxes/oauth/google/start", headers, payload: { returnTo: "organization" } });
    const state = new URL(start.json().authorizationUrl).searchParams.get("state")!;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600, id_token: idToken("ops@acme.test") }), { status: 200 })));
    const callback = await app.inject({ method: "GET", url: `/api/v1/mailboxes/oauth/google/callback?code=abc&state=${state}` });
    expect(callback.headers.location).toBe(`https://jev.acme.test/organizations/${tenant.id}?connected=ops%40acme.test`);
    expect((await app.inject({ method: "POST", url: "/api/v1/mailboxes/oauth/google/start", headers, payload: { returnTo: "https://evil.test" } })).statusCode).toBe(400);
  });

  it("the callback always redirects back with a readable error", async () => {
    const { app, anonymous } = await setup();
    const denied = await app.inject({ method: "GET", url: "/api/v1/mailboxes/oauth/google/callback?error=access_denied&error_description=The+user+denied" });
    expect(denied.headers.location).toBe("https://jev.acme.test/mailboxes?oauthError=The+user+denied");

    const stale = await app.inject({ method: "GET", url: "/api/v1/mailboxes/oauth/google/callback?code=x&state=unknown" });
    expect(new URL(stale.headers.location as string).searchParams.get("oauthError")).toContain("expired or was already used");

    const signedOut = await anonymous.inject({ method: "GET", url: "/api/v1/mailboxes/oauth/google/callback?code=x&state=y" });
    expect(new URL(signedOut.headers.location as string).searchParams.get("oauthError")).toContain("Sign in to Eumaeus first");
  });

  it("settings never return OAuth secrets, and show the redirect URIs to register", async () => {
    await setup();
    const admin = buildServer({ logger: false, authResolver: async () => ({ id: "a", email: "a@x.test", isSuperAdmin: true }) });
    const res = (await admin.inject({ method: "GET", url: "/api/v1/settings" })).json();
    expect(res).toMatchObject({
      googleOAuthClientId: "client-123",
      googleOAuthClientSecretSet: true,
      microsoftOAuthClientSecretSet: false,
      microsoftOAuthTenant: "common",
      oauthRedirectUris: { google: "https://jev.acme.test/api/v1/mailboxes/oauth/google/callback", microsoft: "https://jev.acme.test/api/v1/mailboxes/oauth/microsoft/callback" },
    });
    expect(JSON.stringify(res)).not.toContain("shh");
  });
});
