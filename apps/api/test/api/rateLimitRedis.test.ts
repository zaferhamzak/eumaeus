import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";
import { getRedisConnection } from "../../src/queue/connection.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";
import { SUPERADMIN_TEST_AUTH_RESOLVER } from "../helpers/auth.js";
import { beforeEach } from "vitest";

const rule = { global: { windowMs: 60_000, max: 3 } };

describe("rate limits shared through Redis", () => {
  let tenantId: string;
  beforeEach(async () => {
    await resetDatabase();
    tenantId = (await createTestTenantAndMailbox()).tenant.id;
  });
  it("two API replicas share one budget for the same client", async () => {
    const redis = getRedisConnection();
    const keys = await redis.keys("eumaeus:rl:*");
    if (keys.length) await redis.del(...keys);
    const a = buildServer({ logger: false, rateLimit: rule, rateLimitRedis: redis, tenantResolver: async () => tenantId, authResolver: SUPERADMIN_TEST_AUTH_RESOLVER });
    const b = buildServer({ logger: false, rateLimit: rule, rateLimitRedis: redis, tenantResolver: async () => tenantId, authResolver: SUPERADMIN_TEST_AUTH_RESOLVER });
    const hit = (app: typeof a) => app.inject({ method: "GET", url: "/api/v1/mailboxes", remoteAddress: "203.0.113.20" });
    const codes = [(await hit(a)).statusCode, (await hit(b)).statusCode, (await hit(a)).statusCode, (await hit(b)).statusCode];
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    const limited = await hit(a);
    expect(codes[3]).toBe(429);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.details.retryAfterSeconds).toBeGreaterThan(0);
    // Another client has its own budget.
    expect((await a.inject({ method: "GET", url: "/api/v1/mailboxes", remoteAddress: "203.0.113.21" })).statusCode).toBe(200);
  });

  it("if Redis fails, each replica still limits on its own instead of blocking everyone", async () => {
    const broken = { multi: () => ({ incr: () => ({ pexpire: () => ({ exec: async () => { throw new Error("redis down"); } }) }) }) } as never;
    const app = buildServer({ logger: false, rateLimit: rule, rateLimitRedis: broken, tenantResolver: async () => tenantId, authResolver: SUPERADMIN_TEST_AUTH_RESOLVER });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await app.inject({ method: "GET", url: "/api/v1/mailboxes", remoteAddress: "203.0.113.30" })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
  });
});
