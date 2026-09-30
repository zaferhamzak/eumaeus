import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";
import { SUPERADMIN_TEST_AUTH_RESOLVER } from "../helpers/auth.js";

describe("API — request body size limit (§14)", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("rejects a JSON body larger than the configured limit before it reaches route/service code", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildServer({ logger: false, tenantResolver: async () => tenant.id, authResolver: SUPERADMIN_TEST_AUTH_RESOLVER, bodyLimit: 1024 });

    const oversized = "x".repeat(2000);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/destinations",
      payload: { name: "sales", description: oversized },
    });
    expect(res.statusCode).toBe(413);
    await app.close();
  });

  it("a body within the limit is accepted normally", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildServer({ logger: false, tenantResolver: async () => tenant.id, authResolver: SUPERADMIN_TEST_AUTH_RESOLVER, bodyLimit: 1024 });
    const res = await app.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "sales" } });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it("the default body limit is explicitly configured, not left at whatever Fastify happens to default to", async () => {
    const { DEFAULT_BODY_LIMIT_BYTES } = await import("../../src/api/server.js");
    expect(DEFAULT_BODY_LIMIT_BYTES).toBe(256 * 1024);
  });
});
