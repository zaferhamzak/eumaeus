import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../../src/api/server.js";
import { prisma } from "../../../src/db/client.js";
import { resetDatabase } from "../../helpers/db.js";
import { hashPassword, verifyPassword } from "../../../src/modules/auth/password.js";

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

async function createUser(email: string, password = "correct-horse-battery") {
  return prisma.user.create({ data: { email, passwordHash: await hashPassword(password), status: "active" } });
}

async function loginCookie(instance: ReturnType<typeof app>, email: string, password = "correct-horse-battery", userAgent = "test-agent") {
  const res = await instance.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password }, headers: { "user-agent": userAgent } });
  return extractCookie(res.headers["set-cookie"], "jm_session");
}

describe("brute-force lockout", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("locks an account after 5 wrong passwords — even the CORRECT password is then refused with 429", async () => {
    await createUser("lock@example.com");
    const instance = app();
    for (let i = 0; i < 5; i++) {
      const res = await instance.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "lock@example.com", password: "wrong-password" } });
      expect(res.statusCode).toBe(400);
    }
    const locked = await instance.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "lock@example.com", password: "correct-horse-battery" } });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe("RATE_LIMITED");
    expect(locked.json().error.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("a successful login resets the failure count", async () => {
    await createUser("reset@example.com");
    const instance = app();
    for (let i = 0; i < 4; i++) {
      await instance.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "reset@example.com", password: "wrong-password" } });
    }
    expect(await loginCookie(instance, "reset@example.com")).toBeDefined();
    for (let i = 0; i < 4; i++) {
      await instance.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "reset@example.com", password: "wrong-password" } });
    }
    expect(await loginCookie(instance, "reset@example.com")).toBeDefined();
  });

  it("locks unknown emails too, so lockout behavior doesn't reveal which emails exist", async () => {
    const instance = app();
    for (let i = 0; i < 5; i++) {
      await instance.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "ghost@example.com", password: "x" } });
    }
    const res = await instance.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "ghost@example.com", password: "x" } });
    expect(res.statusCode).toBe(429);
  });
});

describe("POST /api/v1/auth/password", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("changes the password and signs out every OTHER session, keeping the current one", async () => {
    const user = await createUser("pw@example.com");
    const instance = app();
    const current = await loginCookie(instance, "pw@example.com", "correct-horse-battery", "laptop");
    const other = await loginCookie(instance, "pw@example.com", "correct-horse-battery", "phone");

    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      payload: { currentPassword: "correct-horse-battery", newPassword: "a-much-better-passphrase" },
      cookies: { jm_session: current! },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ otherSessionsRevoked: 1 });

    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    await expect(verifyPassword(refreshed.passwordHash, "a-much-better-passphrase")).resolves.toBe(true);

    expect((await instance.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { jm_session: current! } })).statusCode).toBe(200);
    expect((await instance.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { jm_session: other! } })).statusCode).toBe(401);
  });

  it("refuses a wrong current password", async () => {
    await createUser("pw2@example.com");
    const instance = app();
    const cookie = await loginCookie(instance, "pw2@example.com");
    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      payload: { currentPassword: "not-it", newPassword: "a-much-better-passphrase" },
      cookies: { jm_session: cookie! },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe("Current password is incorrect");
  });

  it("refuses a new password shorter than the minimum", async () => {
    await createUser("pw3@example.com");
    const instance = app();
    const cookie = await loginCookie(instance, "pw3@example.com");
    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      payload: { currentPassword: "correct-horse-battery", newPassword: "short" },
      cookies: { jm_session: cookie! },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("session management", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("lists the caller's own sessions with device info, marks the current one, and never exposes the raw token", async () => {
    await createUser("s@example.com");
    const instance = app();
    const current = await loginCookie(instance, "s@example.com", "correct-horse-battery", "laptop-browser");
    await loginCookie(instance, "s@example.com", "correct-horse-battery", "phone-browser");

    const res = await instance.inject({ method: "GET", url: "/api/v1/auth/sessions", cookies: { jm_session: current! } });
    expect(res.statusCode).toBe(200);
    const sessions = res.json().data as Array<{ id: string; current: boolean; userAgent: string }>;
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(sessions.map((s) => s.userAgent).sort()).toEqual(["laptop-browser", "phone-browser"]);
    expect(JSON.stringify(res.json())).not.toContain(current!);
  });

  it("revoking a session by id signs that device out", async () => {
    await createUser("s2@example.com");
    const instance = app();
    const current = await loginCookie(instance, "s2@example.com", "correct-horse-battery", "laptop");
    const other = await loginCookie(instance, "s2@example.com", "correct-horse-battery", "phone");

    const list = (await instance.inject({ method: "GET", url: "/api/v1/auth/sessions", cookies: { jm_session: current! } })).json().data;
    const otherId = list.find((s: { current: boolean }) => !s.current).id;

    const del = await instance.inject({ method: "DELETE", url: `/api/v1/auth/sessions/${otherId}`, cookies: { jm_session: current! } });
    expect(del.statusCode).toBe(204);
    expect((await instance.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { jm_session: other! } })).statusCode).toBe(401);
  });

  it("cannot revoke another user's session", async () => {
    await createUser("a@example.com");
    await createUser("b@example.com");
    const instance = app();
    const aCookie = await loginCookie(instance, "a@example.com");
    const bCookie = await loginCookie(instance, "b@example.com");
    const bSessionId = (await instance.inject({ method: "GET", url: "/api/v1/auth/sessions", cookies: { jm_session: bCookie! } })).json().data[0].id;

    const res = await instance.inject({ method: "DELETE", url: `/api/v1/auth/sessions/${bSessionId}`, cookies: { jm_session: aCookie! } });
    expect(res.statusCode).toBe(404);
    expect((await instance.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { jm_session: bCookie! } })).statusCode).toBe(200);
  });

  it("revoke-others signs out everything except the current session", async () => {
    await createUser("s3@example.com");
    const instance = app();
    const current = await loginCookie(instance, "s3@example.com");
    await loginCookie(instance, "s3@example.com");
    await loginCookie(instance, "s3@example.com");
    const res = await instance.inject({ method: "POST", url: "/api/v1/auth/sessions/revoke-others", cookies: { jm_session: current! } });
    expect(res.json()).toEqual({ revoked: 2 });
    const remaining = (await instance.inject({ method: "GET", url: "/api/v1/auth/sessions", cookies: { jm_session: current! } })).json().data;
    expect(remaining).toHaveLength(1);
  });
});
