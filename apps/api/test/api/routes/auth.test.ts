import { beforeEach, describe, expect, it } from "vitest";
import { TOTP } from "otpauth";
import { buildServer } from "../../../src/api/server.js";
import { prisma } from "../../../src/db/client.js";
import { resetDatabase } from "../../helpers/db.js";
import { createTestUser } from "../../helpers/auth.js";
import { hashPassword } from "../../../src/modules/auth/password.js";
import { encryptSecret } from "../../../src/modules/secrets/secretCrypto.js";
import { generateTotpSecret } from "../../../src/modules/auth/mfa.js";

function app() {
  return buildServer({ logger: false });
}

function extractCookie(setCookieHeader: string | string[] | undefined, name: string): string | undefined {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
  for (const h of headers) {
    if (h.startsWith(`${name}=`)) return h.split(";")[0]?.split("=")[1];
  }
  return undefined;
}

describe("POST /api/v1/auth/login", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("sets a session cookie and returns mfaRequired:false for a correct, non-MFA login", async () => {
    await prisma.user.create({ data: { email: "a@example.com", passwordHash: await hashPassword("hunter2hunter2"), status: "active" } });
    const res = await app().inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "a@example.com", password: "hunter2hunter2" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mfaRequired: false });
    expect(extractCookie(res.headers["set-cookie"], "jm_session")).toBeDefined();
  });

  it("rejects a wrong password with a generic error and records login_failed", async () => {
    await prisma.user.create({ data: { email: "b@example.com", passwordHash: await hashPassword("correct-password"), status: "active" } });
    const res = await app().inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "b@example.com", password: "wrong-password" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe("Invalid email or password");
    expect(extractCookie(res.headers["set-cookie"], "jm_session")).toBeUndefined();
    const events = await prisma.authEvent.findMany({ where: { eventType: "login_failed" } });
    expect(events).toHaveLength(1);
  });

  it("rejects an unknown email with the exact same generic error (no user enumeration)", async () => {
    const res = await app().inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "nobody@example.com", password: "whatever12" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe("Invalid email or password");
  });

  it("a disabled user cannot log in even with the correct password", async () => {
    await prisma.user.create({ data: { email: "c@example.com", passwordHash: await hashPassword("hunter2hunter2"), status: "disabled" } });
    const res = await app().inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "c@example.com", password: "hunter2hunter2" } });
    expect(res.statusCode).toBe(400);
  });

  it("an MFA-enabled user gets mfaRequired:true with a pendingToken and NO cookie", async () => {
    const secret = generateTotpSecret();
    await prisma.user.create({
      data: { email: "mfa@example.com", passwordHash: await hashPassword("hunter2hunter2"), status: "active", mfaEnabled: true, mfaSecret: encryptSecret(secret) },
    });
    const res = await app().inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "mfa@example.com", password: "hunter2hunter2" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mfaRequired).toBe(true);
    expect(typeof body.pendingToken).toBe("string");
    expect(extractCookie(res.headers["set-cookie"], "jm_session")).toBeUndefined();
  });
});

describe("POST /api/v1/auth/login/mfa", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  async function loginToMfaStep(secret: string) {
    const user = await prisma.user.create({
      data: { email: "mfa2@example.com", passwordHash: await hashPassword("hunter2hunter2"), status: "active", mfaEnabled: true, mfaSecret: encryptSecret(secret) },
    });
    const loginRes = await app().inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "mfa2@example.com", password: "hunter2hunter2" } });
    return { user, pendingToken: loginRes.json().pendingToken as string };
  }

  it("the right TOTP code completes login and sets a session cookie", async () => {
    const secret = generateTotpSecret();
    const { pendingToken } = await loginToMfaStep(secret);
    const code = new TOTP({ secret }).generate();
    const instance = app();
    const res = await instance.inject({ method: "POST", url: "/api/v1/auth/login/mfa", payload: { pendingToken, code } });
    expect(res.statusCode).toBe(200);
    expect(extractCookie(res.headers["set-cookie"], "jm_session")).toBeDefined();
  });

  it("the wrong code is rejected and the pending token remains usable for a later correct attempt", async () => {
    const secret = generateTotpSecret();
    const { pendingToken } = await loginToMfaStep(secret);
    const instance = app();
    const wrongRes = await instance.inject({ method: "POST", url: "/api/v1/auth/login/mfa", payload: { pendingToken, code: "000000" } });
    expect(wrongRes.statusCode).toBe(400);

    const code = new TOTP({ secret }).generate();
    const rightRes = await instance.inject({ method: "POST", url: "/api/v1/auth/login/mfa", payload: { pendingToken, code } });
    expect(rightRes.statusCode).toBe(200);
  });

  it("a bogus/unknown pending token is rejected", async () => {
    const res = await app().inject({ method: "POST", url: "/api/v1/auth/login/mfa", payload: { pendingToken: "not-real", code: "123456" } });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/v1/auth/me", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("401s with no session cookie", async () => {
    const res = await app().inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(res.statusCode).toBe(401);
  });

  it("reflects the real user and their active memberships when logged in", async () => {
    const user = await createTestUser({ email: "me@example.com" });
    const tenant = await prisma.tenant.create({ data: { name: "Acme" } });
    await prisma.membership.create({ data: { userId: user.id, tenantId: tenant.id, permissions: ["rules:read"], status: "active" } });

    const instance = app();
    const loginRes = await instance.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "me@example.com", password: "test-password-not-real" },
    });
    const cookie = extractCookie(loginRes.headers["set-cookie"], "jm_session");

    const res = await instance.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { jm_session: cookie! } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.email).toBe("me@example.com");
    expect(body.user.mfaEnabled).toBe(false);
    expect(body.memberships).toEqual([{ organizationId: tenant.id, organizationName: "Acme", permissions: ["rules:read"], status: "active" }]);
  });
});

describe("POST /api/v1/auth/logout", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("clears the session — a subsequent /auth/me with the same cookie is 401", async () => {
    await prisma.user.create({ data: { email: "out@example.com", passwordHash: await hashPassword("hunter2hunter2"), status: "active" } });
    const instance = app();
    const loginRes = await instance.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "out@example.com", password: "hunter2hunter2" } });
    const cookie = extractCookie(loginRes.headers["set-cookie"], "jm_session")!;

    const logoutRes = await instance.inject({ method: "POST", url: "/api/v1/auth/logout", cookies: { jm_session: cookie } });
    expect(logoutRes.statusCode).toBe(204);

    const meRes = await instance.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { jm_session: cookie } });
    expect(meRes.statusCode).toBe(401);
  });
});

describe("MFA enroll/confirm", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  async function loggedInInstance(email: string) {
    await prisma.user.create({ data: { email, passwordHash: await hashPassword("hunter2hunter2"), status: "active" } });
    const instance = app();
    const loginRes = await instance.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "hunter2hunter2" } });
    const cookie = extractCookie(loginRes.headers["set-cookie"], "jm_session")!;
    return { instance, cookie };
  }

  it("enroll returns an otpauth URI; confirming with the right code enables MFA; a later login then requires it", async () => {
    const { instance, cookie } = await loggedInInstance("enroll@example.com");

    const enrollRes = await instance.inject({ method: "POST", url: "/api/v1/auth/mfa/enroll", cookies: { jm_session: cookie } });
    expect(enrollRes.statusCode).toBe(200);
    const { otpauthUri } = enrollRes.json();
    expect(otpauthUri.startsWith("otpauth://totp/")).toBe(true);

    const secretMatch = /secret=([A-Z0-9]+)/.exec(otpauthUri);
    const secret = secretMatch![1]!;
    const code = new TOTP({ secret }).generate();

    const confirmRes = await instance.inject({ method: "POST", url: "/api/v1/auth/mfa/confirm", payload: { code }, cookies: { jm_session: cookie } });
    expect(confirmRes.statusCode).toBe(200);
    expect(confirmRes.json()).toEqual({ mfaEnabled: true });

    const loginRes = await instance.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "enroll@example.com", password: "hunter2hunter2" } });
    expect(loginRes.json().mfaRequired).toBe(true);
  });

  it("confirming with a wrong code does not enable MFA", async () => {
    const { instance, cookie } = await loggedInInstance("badcode@example.com");
    await instance.inject({ method: "POST", url: "/api/v1/auth/mfa/enroll", cookies: { jm_session: cookie } });
    const confirmRes = await instance.inject({ method: "POST", url: "/api/v1/auth/mfa/confirm", payload: { code: "000000" }, cookies: { jm_session: cookie } });
    expect(confirmRes.statusCode).toBe(400);

    const loginRes = await instance.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "badcode@example.com", password: "hunter2hunter2" } });
    expect(loginRes.json().mfaRequired).toBe(false);
  });

  it("enroll returns a scannable QR code data URI alongside the otpauth URI", async () => {
    const { instance, cookie } = await loggedInInstance("qr@example.com");
    const enrollRes = await instance.inject({ method: "POST", url: "/api/v1/auth/mfa/enroll", cookies: { jm_session: cookie } });
    const { qrCodeDataUri } = enrollRes.json();
    expect(qrCodeDataUri.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("disable requires the current TOTP code, then a later login no longer asks for one", async () => {
    const { instance, cookie } = await loggedInInstance("disable@example.com");
    const enrollRes = await instance.inject({ method: "POST", url: "/api/v1/auth/mfa/enroll", cookies: { jm_session: cookie } });
    const secretMatch = /secret=([A-Z0-9]+)/.exec(enrollRes.json().otpauthUri);
    const secret = secretMatch![1]!;
    await instance.inject({ method: "POST", url: "/api/v1/auth/mfa/confirm", payload: { code: new TOTP({ secret }).generate() }, cookies: { jm_session: cookie } });

    const wrongCodeRes = await instance.inject({ method: "POST", url: "/api/v1/auth/mfa/disable", payload: { code: "000000" }, cookies: { jm_session: cookie } });
    expect(wrongCodeRes.statusCode).toBe(400);

    const disableRes = await instance.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/disable",
      payload: { code: new TOTP({ secret }).generate() },
      cookies: { jm_session: cookie },
    });
    expect(disableRes.statusCode).toBe(200);
    expect(disableRes.json()).toEqual({ mfaEnabled: false });

    const loginRes = await instance.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "disable@example.com", password: "hunter2hunter2" } });
    expect(loginRes.json().mfaRequired).toBe(false);
  });
});

describe("POST /api/v1/auth/accept-invite", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("activates the membership, sets the password, and logs the user in", async () => {
    const tenant = await prisma.tenant.create({ data: { name: "Invitee Org" } });
    const { createInvite } = await import("../../../src/modules/auth/authService.js");
    const invite = await createInvite(tenant.id, "invitee@example.com", ["mailboxes:read"]);

    const instance = app();
    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/auth/accept-invite",
      payload: { token: invite.rawToken, password: "brand-new-password" },
    });
    expect(res.statusCode).toBe(200);
    expect(extractCookie(res.headers["set-cookie"], "jm_session")).toBeDefined();

    const membership = await prisma.membership.findUnique({ where: { id: invite.membershipId } });
    expect(membership?.status).toBe("active");
    expect(membership?.inviteTokenHash).toBeNull();
  });

  it("rejects a bogus token", async () => {
    const res = await app().inject({ method: "POST", url: "/api/v1/auth/accept-invite", payload: { token: "not-real", password: "brand-new-password" } });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an already-accepted (no longer pending) token", async () => {
    const tenant = await prisma.tenant.create({ data: { name: "Org2" } });
    const { createInvite } = await import("../../../src/modules/auth/authService.js");
    const invite = await createInvite(tenant.id, "twice@example.com", []);
    const instance = app();
    await instance.inject({ method: "POST", url: "/api/v1/auth/accept-invite", payload: { token: invite.rawToken, password: "brand-new-password" } });
    const secondRes = await instance.inject({ method: "POST", url: "/api/v1/auth/accept-invite", payload: { token: invite.rawToken, password: "another-password" } });
    expect(secondRes.statusCode).toBe(400);
  });
});
