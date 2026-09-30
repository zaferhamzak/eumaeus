import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";

describe("API — health/readiness", () => {
  it("GET /api/v1/health reports the process is alive, with no dependency checks", async () => {
    const app = buildServer({ logger: false });
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("GET /api/v1/ready reports ok with database/redis checks when both are healthy", async () => {
    const app = buildServer({ logger: false });
    const res = await app.inject({ method: "GET", url: "/api/v1/ready" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ status: "ok", checks: { database: "ok", redis: "ok" } });
    await app.close();
  });

  it("health does not require a tenant to exist (registered outside the tenant-context scope)", async () => {
    // No tenantResolver override, no tenant created — the default resolver would
    // throw CONFIGURATION_ERROR if it were reached; health/ready must never
    // reach it.
    const app = buildServer({ logger: false });
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
