import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";
import { SUPERADMIN_TEST_AUTH_RESOLVER } from "../helpers/auth.js";

describe("API — rate limiting", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("returns 429 once the global limit is exceeded, with a documented error code and Retry-After information", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildServer({
      logger: false,
      tenantResolver: async () => tenant.id,
      authResolver: SUPERADMIN_TEST_AUTH_RESOLVER,
      rateLimit: { global: { windowMs: 60_000, max: 3 } },
    });

    for (let i = 0; i < 3; i++) {
      const ok = await app.inject({ method: "GET", url: "/api/v1/mailboxes" });
      expect(ok.statusCode).toBe(200);
    }
    const limited = await app.inject({ method: "GET", url: "/api/v1/mailboxes" });
    expect(limited.statusCode).toBe(429);
    const body = limited.json();
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    await app.close();
  });

  it("does not rate-limit health/ready (registered outside the limited scope)", async () => {
    const app = buildServer({ logger: false, rateLimit: { global: { windowMs: 60_000, max: 1 } } });
    // Exceed the (tiny) global limit via a substantive route path is not
    // possible here (no tenant needed for health) — instead directly hammer
    // /health, which must never be subject to the limiter at all.
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: "GET", url: "/api/v1/health" });
      expect(res.statusCode).toBe(200);
    }
    await app.close();
  });

  it("a stricter endpoint-specific limit applies to the retry endpoint in addition to the global limit", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const app = buildServer({
      logger: false,
      tenantResolver: async () => tenant.id,
      authResolver: SUPERADMIN_TEST_AUTH_RESOLVER,
      rateLimit: {
        global: { windowMs: 60_000, max: 1000 },
        routes: { "POST /api/v1/mailboxes/:id/reconcile": { windowMs: 60_000, max: 2 } },
      },
    });

    for (let i = 0; i < 2; i++) {
      const ok = await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxConnection.id}/reconcile` });
      expect(ok.statusCode).toBe(202);
    }
    const limited = await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxConnection.id}/reconcile` });
    expect(limited.statusCode).toBe(429);

    // The global limit is untouched — a normal read still works.
    const stillFine = await app.inject({ method: "GET", url: "/api/v1/mailboxes" });
    expect(stillFine.statusCode).toBe(200);
    await app.close();
  });

  it("rate limiting is per-process/in-memory — two independently-built app instances do not share limiter state (documents the process-local limitation)", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const rateLimit = { global: { windowMs: 60_000, max: 1 } };
    const appA = buildServer({ logger: false, tenantResolver: async () => tenant.id, authResolver: SUPERADMIN_TEST_AUTH_RESOLVER, rateLimit });
    const appB = buildServer({ logger: false, tenantResolver: async () => tenant.id, authResolver: SUPERADMIN_TEST_AUTH_RESOLVER, rateLimit });

    const a1 = await appA.inject({ method: "GET", url: "/api/v1/mailboxes" });
    expect(a1.statusCode).toBe(200);
    const a2 = await appA.inject({ method: "GET", url: "/api/v1/mailboxes" });
    expect(a2.statusCode).toBe(429); // appA's own limit is exhausted

    const b1 = await appB.inject({ method: "GET", url: "/api/v1/mailboxes" });
    expect(b1.statusCode).toBe(200); // appB has its OWN, independent limiter state

    await appA.close();
    await appB.close();
  });
});
