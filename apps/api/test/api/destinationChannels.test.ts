import { beforeEach, describe, expect, it } from "vitest";
import { buildTestServer } from "./helpers/buildTestServer.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/db/client.js";

async function createDestinationWithArchive(tenantId: string) {
  const app = buildTestServer(tenantId);
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/destinations",
    payload: { name: "spam", channels: [{ type: "archive", config: { folder: "Junk" } }] },
  });
  return { app, destination: res.json() };
}

describe("channels on an existing destination", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("adds a second channel to a destination created earlier", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const { app, destination } = await createDestinationWithArchive(tenant.id);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/destinations/${destination.id}/channels`,
      payload: { type: "webhook", config: { url: "https://hooks.example.com/in" } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().channels.map((c: { type: string }) => c.type).sort()).toEqual(["archive", "webhook"]);
  });

  it("rejects an invalid channel config", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const { app, destination } = await createDestinationWithArchive(tenant.id);
    const res = await app.inject({ method: "POST", url: `/api/v1/destinations/${destination.id}/channels`, payload: { type: "archive", config: {} } });
    expect(res.statusCode).toBe(400);
  });

  it("editing creates a new VERSION — the old row is deactivated, never mutated in place", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const { app, destination } = await createDestinationWithArchive(tenant.id);
    const oldChannelId = destination.channels[0].id;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/destinations/${destination.id}/channels/${oldChannelId}`,
      payload: { config: { folder: "Trash" } },
    });
    expect(res.statusCode).toBe(200);

    const old = await prisma.destinationChannel.findUniqueOrThrow({ where: { id: oldChannelId } });
    expect(old.enabled).toBe(false);
    expect((old.config as { folder: string }).folder).toBe("Junk");

    const live = res.json().channels.filter((c: { enabled: boolean }) => c.enabled);
    expect(live).toHaveLength(1);
    expect(live[0].config.folder).toBe("Trash");
    expect(live[0].version).toBe(2);
  });

  it("disables a single channel, leaving the others live", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const { app, destination } = await createDestinationWithArchive(tenant.id);
    await app.inject({ method: "POST", url: `/api/v1/destinations/${destination.id}/channels`, payload: { type: "webhook", config: { url: "https://hooks.example.com/in" } } });
    const archiveId = destination.channels[0].id;

    const res = await app.inject({ method: "DELETE", url: `/api/v1/destinations/${destination.id}/channels/${archiveId}` });
    expect(res.statusCode).toBe(200);
    const live = res.json().channels.filter((c: { enabled: boolean }) => c.enabled);
    expect(live.map((c: { type: string }) => c.type)).toEqual(["webhook"]);
  });

  it("cannot edit or disable a channel belonging to another tenant's destination", async () => {
    const { tenant: tA } = await createTestTenantAndMailbox();
    const { tenant: tB } = await createTestTenantAndMailbox();
    const { destination: destB } = await createDestinationWithArchive(tB.id);
    const channelB = destB.channels[0].id;

    const appA = buildTestServer(tA.id);
    const edit = await appA.inject({ method: "PATCH", url: `/api/v1/destinations/${destB.id}/channels/${channelB}`, payload: { config: { folder: "Stolen" } } });
    expect(edit.statusCode).toBe(404);
    const del = await appA.inject({ method: "DELETE", url: `/api/v1/destinations/${destB.id}/channels/${channelB}` });
    expect(del.statusCode).toBe(404);

    const untouched = await prisma.destinationChannel.findUniqueOrThrow({ where: { id: channelB } });
    expect(untouched.enabled).toBe(true);
  });

  it("cannot add a channel to another tenant's destination", async () => {
    const { tenant: tA } = await createTestTenantAndMailbox();
    const { tenant: tB } = await createTestTenantAndMailbox();
    const { destination: destB } = await createDestinationWithArchive(tB.id);
    const res = await buildTestServer(tA.id).inject({
      method: "POST",
      url: `/api/v1/destinations/${destB.id}/channels`,
      payload: { type: "archive", config: { folder: "X" } },
    });
    expect(res.statusCode).toBe(404);
  });
});
