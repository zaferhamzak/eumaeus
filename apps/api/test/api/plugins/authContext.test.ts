import { describe, expect, it } from "vitest";
import { buildServer } from "../../../src/api/server.js";
import { createSession } from "../../../src/modules/auth/sessionStore.js";
import { resetDatabase } from "../../helpers/db.js";
import { createTestUser } from "../../helpers/auth.js";

/**
 * Phase 11, step 3 of the rollout: authContext is wired but nothing yet
 * reads request.user to gate anything (that's tenantContext.ts's rewrite,
 * step 5) — this test proves the plugin itself resolves request.user
 * correctly in isolation, independent of any route's behavior.
 */
describe("authContext plugin — resolves request.user from the session cookie", () => {
  it("request.user is null with no cookie at all", async () => {
    const app = buildServer({ logger: false });
    app.get("/__probe", async (request) => ({ user: request.user }));
    const res = await app.inject({ method: "GET", url: "/__probe" });
    expect(res.json()).toEqual({ user: null });
  });

  it("request.user is null for a cookie that doesn't match any real session", async () => {
    const app = buildServer({ logger: false });
    app.get("/__probe", async (request) => ({ user: request.user }));
    const res = await app.inject({ method: "GET", url: "/__probe", cookies: { jm_session: "not-a-real-token" } });
    expect(res.json()).toEqual({ user: null });
  });

  it("request.user reflects the real user for a valid session cookie", async () => {
    await resetDatabase();
    const user = await createTestUser({ email: "probe@example.com" });
    const token = await createSession(user.id);

    const app = buildServer({ logger: false });
    app.get("/__probe", async (request) => ({ user: request.user }));
    const res = await app.inject({ method: "GET", url: "/__probe", cookies: { jm_session: token } });
    expect(res.json()).toEqual({ user: { id: user.id, email: "probe@example.com", isSuperAdmin: false } });
  });

  it("request.user is null once the user's status is disabled, even with a valid session", async () => {
    await resetDatabase();
    const user = await createTestUser({ email: "disabled@example.com", status: "disabled" });
    const token = await createSession(user.id);

    const app = buildServer({ logger: false });
    app.get("/__probe", async (request) => ({ user: request.user }));
    const res = await app.inject({ method: "GET", url: "/__probe", cookies: { jm_session: token } });
    expect(res.json()).toEqual({ user: null });
  });
});
