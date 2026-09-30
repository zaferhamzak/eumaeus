import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../src/api/server.js";
import { prisma } from "../../src/db/client.js";
import { encryptSecret } from "../../src/modules/secrets/secretCrypto.js";
import { clearSystemSettingsCache, getSystemSettings, updateSystemSettings } from "../../src/modules/settings/systemSettings.js";
import { verifiedEmail } from "../../src/modules/auth/sso.js";
import { createTestUser } from "../helpers/auth.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";

const CLIENT_ID = "google-client.apps.googleusercontent.com";

function idToken(claims: Record<string, unknown>): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;
}

async function enableGoogle(domains: string[] = []) {
  const settings = await getSystemSettings();
  await prisma.systemSettings.update({
    where: { id: settings.id },
    data: { googleOAuthClientId: CLIENT_ID, googleOAuthClientSecretEncrypted: encryptSecret("s3cret"), ssoGoogleEnabled: true, ssoAllowedDomains: domains },
  });
  clearSystemSettingsCache();
}

/** Starts SSO, then plays the provider: the token endpoint answers with an ID token for `email`. */
async function signIn(email: string, opts: { claims?: Record<string, unknown>; sameBrowser?: boolean } = {}) {
  const app = buildServer({ logger: false });
  const start = await app.inject({ method: "GET", url: "/api/v1/auth/sso/google/start" });
  expect(start.statusCode).toBe(302);
  const location = new URL(String(start.headers.location));
  const state = location.searchParams.get("state")!;
  const nonce = location.searchParams.get("nonce")!;
  const cookie = [start.headers["set-cookie"]].flat().find((c) => String(c).startsWith("jm_sso_state="))!;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "at",
          id_token: idToken({ iss: "https://accounts.google.com", aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 300, nonce, email, email_verified: true, ...opts.claims }),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
  );
  const callback = await app.inject({
    method: "GET",
    url: `/api/v1/auth/sso/google/callback?code=abc&state=${state}`,
    headers: opts.sameBrowser === false ? {} : { cookie: String(cookie).split(";")[0] },
  });
  return { location, callback };
}

describe("SSO sign-in", () => {
  beforeEach(resetDatabase);
  afterEach(() => vi.unstubAllGlobals());

  it("signs in an existing account and accepts its pending invitation", async () => {
    await enableGoogle();
    const { tenant } = await createTestTenantAndMailbox();
    const user = await createTestUser({ email: "ayse@acme.test" });
    await prisma.membership.create({ data: { userId: user.id, tenantId: tenant.id, permissions: ["emails:read"], status: "pending", inviteExpiresAt: new Date(Date.now() + 86_400_000) } });

    const { location, callback } = await signIn("Ayse@Acme.test");
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location.searchParams.get("scope")).toBe("openid email profile");
    expect(location.searchParams.get("redirect_uri")).toMatch(/\/api\/v1\/auth\/sso\/google\/callback$/);
    expect(callback.statusCode).toBe(302);
    expect(new URL(String(callback.headers.location)).pathname).toBe("/");
    expect(String(callback.headers["set-cookie"])).toContain("jm_session=");
    expect((await prisma.membership.findFirstOrThrow({ where: { userId: user.id } })).status).toBe("active");
    expect(await prisma.authEvent.count({ where: { userId: user.id, eventType: "login_succeeded" } })).toBe(1);
  });

  it("refuses unknown accounts, disallowed domains and a callback from another browser; MFA still applies", async () => {
    await enableGoogle(["acme.test"]);
    const errorOf = (res: { headers: Record<string, unknown> }) => new URL(String(res.headers.location)).searchParams.get("ssoError");

    expect(errorOf((await signIn("nobody@acme.test")).callback)).toMatch(/no Eumaeus account/);
    expect(errorOf((await signIn("x@other.test")).callback)).toMatch(/other\.test can't sign in/);
    await createTestUser({ email: "cem@acme.test" });
    expect(errorOf((await signIn("cem@acme.test", { sameBrowser: false })).callback)).toMatch(/different browser/);
    expect(errorOf((await signIn("cem@acme.test", { claims: { email_verified: false } })).callback)).toMatch(/verified/);

    const mfaUser = await createTestUser({ email: "mfa@acme.test" });
    await prisma.user.update({ where: { id: mfaUser.id }, data: { mfaEnabled: true, mfaSecret: encryptSecret("JBSWY3DPEHPK3PXP") } });
    const mfa = (await signIn("mfa@acme.test")).callback;
    expect(new URL(String(mfa.headers.location)).searchParams.get("mfaToken")).toBeTruthy();
    expect(String(mfa.headers["set-cookie"] ?? "")).not.toContain("jm_session=");
  });

  it("checks the ID token's issuer, audience, expiry and nonce", () => {
    const expected = { clientId: CLIENT_ID, nonce: "n1" };
    const ok = { iss: "https://accounts.google.com", aud: CLIENT_ID, exp: Date.now() / 1000 + 60, nonce: "n1", email: "A@B.test", email_verified: true };
    expect(verifiedEmail("google", ok, expected)).toBe("a@b.test");
    expect(() => verifiedEmail("google", { ...ok, aud: "someone-else" }, expected)).toThrow(/wasn't issued/);
    expect(() => verifiedEmail("google", { ...ok, iss: "https://evil.test" }, expected)).toThrow(/wasn't issued/);
    expect(() => verifiedEmail("google", { ...ok, exp: Date.now() / 1000 - 1 }, expected)).toThrow(/expired/);
    expect(() => verifiedEmail("google", { ...ok, nonce: "other" }, expected)).toThrow(/doesn't match/);
    expect(verifiedEmail("microsoft", { iss: "https://login.microsoftonline.com/tid-1/v2.0", aud: CLIENT_ID, exp: Date.now() / 1000 + 60, nonce: "n1", preferred_username: "u@corp.test" }, expected)).toBe("u@corp.test");
  });

  it("is off until turned on, and can't be turned on without the app", async () => {
    const res = await buildServer({ logger: false }).inject({ method: "GET", url: "/api/v1/auth/sso/google/start" });
    expect(new URL(String(res.headers.location)).searchParams.get("ssoError")).toMatch(/not turned on/);
    expect((await buildServer({ logger: false }).inject({ method: "GET", url: "/api/v1/auth/sso/providers" })).json()).toEqual({ google: false, microsoft: false });
    await expect(updateSystemSettings({ ssoGoogleEnabled: true }, "admin")).rejects.toThrow(/Set up the Google app first/);
    await expect(updateSystemSettings({ ssoAllowedDomains: ["not a domain"] }, "admin")).rejects.toThrow(/Not a valid domain/);
  });
});
