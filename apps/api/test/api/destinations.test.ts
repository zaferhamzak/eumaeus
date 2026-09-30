import { beforeEach, describe, expect, it } from "vitest";
import { buildTestServer } from "./helpers/buildTestServer.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/db/client.js";

async function tenant() {
  const { tenant } = await createTestTenantAndMailbox();
  return tenant;
}

describe("API — destinations", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("creates a destination with an archive channel", async () => {
    const t = await tenant();
    const app = buildTestServer(t.id);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/destinations",
      payload: { name: "sales", channels: [{ type: "archive", config: { folder: "Sales" } }] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe("sales");
    expect(body.channels).toHaveLength(1);
    expect(body.channels[0]).toMatchObject({ type: "archive", config: { folder: "Sales" } });
    await app.close();
  });

  it("creates a destination with a webhook channel, redacting the URL path in the response", async () => {
    const t = await tenant();
    const app = buildTestServer(t.id);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/destinations",
      payload: {
        name: "hooks",
        channels: [{ type: "webhook", config: { url: "https://hooks.example.com/T00/B00/super-secret-token-path" } }],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    const url = body.channels[0].config.url as string;
    expect(url).toContain("hooks.example.com");
    expect(url).not.toContain("super-secret-token-path");
    await app.close();
  });

  it("rejects an unsupported channel type", async () => {
    const t = await tenant();
    const app = buildTestServer(t.id);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/destinations",
      payload: { name: "bad", channels: [{ type: "slack", config: {} }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    await app.close();
  });

  it("rejects creating a destination named the reserved human_review value", async () => {
    const t = await tenant();
    const app = buildTestServer(t.id);
    const res = await app.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "human_review" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("lists destinations for the current tenant only", async () => {
    const tA = await tenant();
    const tB = await tenant();
    const appA = buildTestServer(tA.id);
    await appA.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "only-a" } });
    const appB = buildTestServer(tB.id);
    await appB.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "only-b" } });

    const res = await appA.inject({ method: "GET", url: "/api/v1/destinations" });
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe("only-a");
    await appA.close();
    await appB.close();
  });

  it("gets destination detail with its channels", async () => {
    const t = await tenant();
    const app = buildTestServer(t.id);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/destinations",
      payload: { name: "sales", channels: [{ type: "archive", config: { folder: "Sales" } }] },
    });
    const id = created.json().id as string;

    const res = await app.inject({ method: "GET", url: `/api/v1/destinations/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().channels).toHaveLength(1);
    await app.close();
  });

  it("updates a destination's name/description", async () => {
    const t = await tenant();
    const app = buildTestServer(t.id);
    const created = await app.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "sales" } });
    const id = created.json().id as string;

    const res = await app.inject({ method: "PATCH", url: `/api/v1/destinations/${id}`, payload: { description: "Sales team" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "sales", description: "Sales team" });
    await app.close();
  });

  it("deletes (disables all channels of) a destination — the row and name remain, resolution now finds nothing enabled", async () => {
    const t = await tenant();
    const app = buildTestServer(t.id);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/destinations",
      payload: { name: "sales", channels: [{ type: "archive", config: { folder: "Sales" } }] },
    });
    const id = created.json().id as string;

    const deleteRes = await app.inject({ method: "DELETE", url: `/api/v1/destinations/${id}` });
    expect(deleteRes.statusCode).toBe(204);

    const detail = await app.inject({ method: "GET", url: `/api/v1/destinations/${id}` });
    expect(detail.json().channels[0]).toMatchObject({ enabled: false });
    await app.close();
  });

  it("a destination belonging to a different tenant is not found", async () => {
    const tA = await tenant();
    const tB = await tenant();
    const appB = buildTestServer(tB.id);
    const created = await appB.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "b-only" } });
    const id = created.json().id as string;

    const appA = buildTestServer(tA.id);
    const res = await appA.inject({ method: "GET", url: `/api/v1/destinations/${id}` });
    expect(res.statusCode).toBe(404);
    await appA.close();
    await appB.close();
  });
});

describe("API — destination secrets", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("PUT creates a secret, response never contains the plaintext or the encrypted value", async () => {
    const t = await tenant();
    const app = buildTestServer(t.id);
    const created = await app.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "hooks" } });
    const destinationId = created.json().id as string;

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/destinations/${destinationId}/secrets/signing_key`,
      payload: { value: "extremely-secret-value" },
    });
    expect(res.statusCode).toBe(200);
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain("extremely-secret-value");
    expect(raw).not.toContain("encryptedValue");
    await app.close();
  });

  it("the persisted row never contains the plaintext", async () => {
    const t = await tenant();
    const app = buildTestServer(t.id);
    const created = await app.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "hooks" } });
    const destinationId = created.json().id as string;
    await app.inject({ method: "PUT", url: `/api/v1/destinations/${destinationId}/secrets/signing_key`, payload: { value: "the-real-secret" } });

    const row = await prisma.destinationSecret.findFirstOrThrow({ where: { destinationId } });
    expect(row.encryptedValue).not.toContain("the-real-secret");
    await app.close();
  });

  it("GET lists secret metadata only", async () => {
    const t = await tenant();
    const app = buildTestServer(t.id);
    const created = await app.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "hooks" } });
    const destinationId = created.json().id as string;
    await app.inject({ method: "PUT", url: `/api/v1/destinations/${destinationId}/secrets/signing_key`, payload: { value: "v1" } });

    const res = await app.inject({ method: "GET", url: `/api/v1/destinations/${destinationId}/secrets` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ name: "signing_key" });
    expect(body.data[0]).not.toHaveProperty("encryptedValue");
    await app.close();
  });

  it("DELETE removes a secret", async () => {
    const t = await tenant();
    const app = buildTestServer(t.id);
    const created = await app.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "hooks" } });
    const destinationId = created.json().id as string;
    await app.inject({ method: "PUT", url: `/api/v1/destinations/${destinationId}/secrets/signing_key`, payload: { value: "v1" } });

    const deleteRes = await app.inject({ method: "DELETE", url: `/api/v1/destinations/${destinationId}/secrets/signing_key` });
    expect(deleteRes.statusCode).toBe(204);

    const list = await app.inject({ method: "GET", url: `/api/v1/destinations/${destinationId}/secrets` });
    expect(list.json().data).toHaveLength(0);
    await app.close();
  });

  it("PUT for a nonexistent destination is 404, not a silently-orphaned secret", async () => {
    const t = await tenant();
    const app = buildTestServer(t.id);
    const res = await app.inject({ method: "PUT", url: "/api/v1/destinations/does-not-exist/secrets/x", payload: { value: "v" } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
