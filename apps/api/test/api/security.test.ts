import { beforeEach, describe, expect, it } from "vitest";
import { buildTestServer } from "./helpers/buildTestServer.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";
import { loadEnv } from "../../src/config/env.js";

const FORBIDDEN_SUBSTRINGS = [
  "test-password-not-real", // MAIL_PASSWORD test value
  "webhook-super-secret-value",
];

function assertResponseIsClean(body: unknown): void {
  const raw = JSON.stringify(body);
  for (const forbidden of FORBIDDEN_SUBSTRINGS) {
    expect(raw).not.toContain(forbidden);
  }
  expect(raw).not.toContain(loadEnv().SECRET_ENCRYPTION_KEY);
  expect(raw.toLowerCase()).not.toContain("encryptedvalue");
  expect(raw.toLowerCase()).not.toContain("authorization");
}

describe("API — cross-cutting secret/credential exposure checks", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("mailbox list/detail never leak MAIL_PASSWORD or any password-shaped field", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);

    const list = await app.inject({ method: "GET", url: "/api/v1/mailboxes" });
    assertResponseIsClean(list.json());

    const detail = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxConnection.id}` });
    assertResponseIsClean(detail.json());
    expect(detail.json()).not.toHaveProperty("password");
    await app.close();
  });

  it("destination secret PUT/GET responses never leak the plaintext or SECRET_ENCRYPTION_KEY", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const created = await app.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "hooks" } });
    const destinationId = created.json().id as string;

    const put = await app.inject({
      method: "PUT",
      url: `/api/v1/destinations/${destinationId}/secrets/signing_key`,
      payload: { value: "webhook-super-secret-value" },
    });
    assertResponseIsClean(put.json());

    const list = await app.inject({ method: "GET", url: `/api/v1/destinations/${destinationId}/secrets` });
    assertResponseIsClean(list.json());
    await app.close();
  });

  it("a webhook destination's full URL (potentially token-bearing path) is never returned verbatim", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/destinations",
      payload: { name: "hooks", channels: [{ type: "webhook", config: { url: "https://hooks.slack.com/services/T00/B00/xoxb-fake-token" } }] },
    });
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain("xoxb-fake-token");
    expect(raw).not.toContain("/services/T00/B00");
    await app.close();
  });

  it("an unexpected internal error response never contains SECRET_ENCRYPTION_KEY or a stack trace", async () => {
    const { buildServer } = await import("../../src/api/server.js");
    const app = buildServer({
      logger: false,
      tenantResolver: async () => {
        throw new Error(`boom, key=${loadEnv().SECRET_ENCRYPTION_KEY}`);
      },
    });
    const res = await app.inject({ method: "GET", url: "/api/v1/mailboxes" });
    expect(res.statusCode).toBe(500);
    assertResponseIsClean(res.json());
    await app.close();
  });
});
