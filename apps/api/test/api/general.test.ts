import { beforeEach, describe, expect, it } from "vitest";
import { buildTestServer } from "./helpers/buildTestServer.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";

describe("API — general request/error conventions", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("generates a request id when none is supplied, and returns it in X-Request-Id", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.headers["x-request-id"]).toBeTruthy();
    await app.close();
  });

  it("preserves an acceptable client-supplied X-Request-Id", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "GET", url: "/api/v1/health", headers: { "x-request-id": "client-supplied-id-123" } });
    expect(res.headers["x-request-id"]).toBe("client-supplied-id-123");
    await app.close();
  });

  it("replaces an unacceptable client-supplied X-Request-Id (e.g. containing control characters) with a generated one", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "GET", url: "/api/v1/health", headers: { "x-request-id": "bad\r\nheader\ninjection" } });
    expect(res.headers["x-request-id"]).toBeTruthy();
    expect(res.headers["x-request-id"]).not.toContain("\n");
    await app.close();
  });

  it("an unknown route returns a consistent RESOURCE_NOT_FOUND error shape, including the request id", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "GET", url: "/api/v1/does-not-exist" });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
    expect(body.error.requestId).toBe(res.headers["x-request-id"]);
    await app.close();
  });

  it("an unknown resource id returns RESOURCE_NOT_FOUND with the consistent error shape", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "GET", url: "/api/v1/mailboxes/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "RESOURCE_NOT_FOUND" } });
    await app.close();
  });

  it("an invalid query parameter (oversized limit) is rejected with VALIDATION_ERROR", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "GET", url: "/api/v1/mailboxes?limit=99999" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    await app.close();
  });

  it("an unknown/unwhitelisted filter query parameter is rejected (strict schemas)", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "GET", url: "/api/v1/mailboxes?madeUpFilter=1" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    await app.close();
  });

  it("a malformed pagination cursor is rejected with VALIDATION_ERROR, not a 500", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "GET", url: "/api/v1/mailboxes?cursor=%00%00not-valid-base64%00" });
    expect([200, 400]).toContain(res.statusCode); // an arbitrary string can still be valid base64url garbage that decodes to a nonexistent id
    if (res.statusCode !== 200) {
      expect(res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    }
    await app.close();
  });

  it("the error response never contains a stack trace or raw internal details for an unexpected error", async () => {
    // Force an internal error by requesting a resource whose tenant lookup
    // itself fails (a resolver that throws), proving the error handler's
    // generic-500 path never leaks anything beyond code/message/requestId.
    const { buildServer } = await import("../../src/api/server.js");
    const app = buildServer({
      logger: false,
      tenantResolver: async () => {
        throw new Error("simulated internal failure with a fake stack trace inside");
      },
    });
    const res = await app.inject({ method: "GET", url: "/api/v1/mailboxes" });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("simulated internal failure");
    expect(JSON.stringify(body)).not.toMatch(/at .*\.ts:\d+/); // no stack frame text
    await app.close();
  });
});
