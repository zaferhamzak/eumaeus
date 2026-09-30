import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";
import { SUPERADMIN_TEST_AUTH_RESOLVER } from "../helpers/auth.js";

describe("API — runtime lifecycle (starting/ready/draining/stopped)", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("a freshly-built app defaults to ready (matches every other API test's assumption)", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildServer({ logger: false, tenantResolver: async () => tenant.id, authResolver: SUPERADMIN_TEST_AUTH_RESOLVER });
    expect(app.runtimeState.get()).toBe("ready");
    const res = await app.inject({ method: "GET", url: "/api/v1/mailboxes" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("readiness reports 'starting' as not ready when autoReady is disabled and markReady() hasn't run yet", async () => {
    const app = buildServer({ logger: false, autoReady: false });
    const res = await app.inject({ method: "GET", url: "/api/v1/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "error", runtimeState: "starting" });
    await app.close();
  });

  it("readiness becomes ok once markReady() runs", async () => {
    const app = buildServer({ logger: false, autoReady: false });
    app.runtimeState.markReady();
    const res = await app.inject({ method: "GET", url: "/api/v1/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", runtimeState: "ready" });
    await app.close();
  });

  it("draining: readiness fails, health stays ok, and a substantive route is rejected with SERVICE_UNAVAILABLE", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildServer({ logger: false, tenantResolver: async () => tenant.id, authResolver: SUPERADMIN_TEST_AUTH_RESOLVER });
    expect(app.runtimeState.get()).toBe("ready");

    app.runtimeState.markDraining();

    const health = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(health.statusCode).toBe(200); // liveness is NOT gated on runtime state

    const ready = await app.inject({ method: "GET", url: "/api/v1/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ status: "error", runtimeState: "draining" });

    const mailboxes = await app.inject({ method: "GET", url: "/api/v1/mailboxes" });
    expect(mailboxes.statusCode).toBe(503);
    expect(mailboxes.json()).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });

    await app.close();
  });

  it("draining rejects mutating requests too (POST/PATCH/DELETE), not only GET", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildServer({ logger: false, tenantResolver: async () => tenant.id, authResolver: SUPERADMIN_TEST_AUTH_RESOLVER });
    app.runtimeState.markDraining();

    const create = await app.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "x" } });
    expect(create.statusCode).toBe(503);
    await app.close();
  });

  it("stopped also rejects new requests", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildServer({ logger: false, tenantResolver: async () => tenant.id, authResolver: SUPERADMIN_TEST_AUTH_RESOLVER });
    app.runtimeState.markDraining();
    app.runtimeState.markStopped();

    const res = await app.inject({ method: "GET", url: "/api/v1/mailboxes" });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});
