import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";
import { buildTestServer } from "./helpers/buildTestServer.js";
import { createTestMembership, createTestUser } from "../helpers/auth.js";
import { createMatchedRoutingDecision, createReceivedEmail, createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/db/client.js";

describe("flag channels and archive flags (Phase 15)", () => {
  beforeEach(resetDatabase);

  it("accepts a flag channel and archive flags, normalizing keywords", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const flag = await app.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "Star", channels: [{ type: "flag", config: { flagged: true, keywords: [" Pazarlama ", "Pazarlama"] } }] } });
    expect(flag.statusCode).toBe(201);
    expect(flag.json().channels[0].config).toEqual({ markSeen: false, flagged: true, keywords: ["Pazarlama"] });

    const archive = await app.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "Junk", channels: [{ type: "archive", config: { folder: "Junk", markSeen: true } }] } });
    expect(archive.json().channels[0].config).toEqual({ folder: "Junk", markSeen: true, flagged: false, keywords: [] });
  });

  it.each([
    [{ type: "flag", config: {} }, "at least one"],
    [{ type: "flag", config: { keywords: ["two words"] } }, "not valid"],
    [{ type: "flag", config: { keywords: ["\\Seen"] } }, "not valid"],
    [{ type: "flag", config: { markSeen: "yes" } }, "boolean"],
    [{ type: "archive", config: { folder: "Junk", colour: "red" } }, "unknown setting"],
  ])("rejects %j", async (channel, message) => {
    const { tenant } = await createTestTenantAndMailbox();
    const res = await buildTestServer(tenant.id).inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "X", channels: [channel] } });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain(message);
  });

  it("a destination can't have both a flag and an archive channel", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const both = await app.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "Both", channels: [{ type: "flag", config: { flagged: true } }, { type: "archive", config: { folder: "Junk" } }] } });
    expect(both.statusCode).toBe(400);
    expect(await prisma.destination.count()).toBe(0);

    const created = (await app.inject({ method: "POST", url: "/api/v1/destinations", payload: { name: "Junk", channels: [{ type: "archive", config: { folder: "Junk" } }] } })).json();
    const add = await app.inject({ method: "POST", url: `/api/v1/destinations/${created.id}/channels`, payload: { type: "flag", config: { flagged: true } } });
    expect(add.statusCode).toBe(400);
    expect(JSON.stringify(add.json())).toContain("set the flags on the archive channel");
  });
});

describe("POST /api/v1/action-executions/:id/undo", () => {
  beforeEach(resetDatabase);

  async function archivedExecution() {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
    const destination = await prisma.destination.create({ data: { tenantId: tenant.id, name: "Junk" } });
    const channel = await prisma.destinationChannel.create({ data: { tenantId: tenant.id, destinationId: destination.id, type: "webhook", config: { url: "https://x.test" }, enabled: true, version: 1 } });
    const decision = await createMatchedRoutingDecision(tenant.id, email.id, "Junk");
    const execution = await prisma.actionExecution.create({
      data: { tenantId: tenant.id, emailId: email.id, routingDecisionId: decision.id, destinationChannelId: channel.id, channelType: "webhook", channelVersion: 1, idempotencyKey: "k", attemptNumber: 1, status: "succeeded" },
    });
    return { tenant, execution };
  }

  it("needs action_executions:undo", async () => {
    const { tenant, execution } = await archivedExecution();
    const user = await createTestUser();
    await createTestMembership(user.id, tenant.id, ["action_executions:read", "action_executions:retry"]);
    const res = await buildServer({ logger: false, authResolver: async () => ({ id: user.id, email: user.email, isSuperAdmin: false }) }).inject({
      method: "POST",
      url: `/api/v1/action-executions/${execution.id}/undo`,
      headers: { "x-organization-id": tenant.id },
    });
    expect(res.statusCode).toBe(403);
  });

  it("explains why a webhook can't be undone (409), and 404s an unknown id", async () => {
    const { tenant, execution } = await archivedExecution();
    const app = buildTestServer(tenant.id);
    const refused = await app.inject({ method: "POST", url: `/api/v1/action-executions/${execution.id}/undo` });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toContain("can't be taken back");
    expect((await app.inject({ method: "POST", url: "/api/v1/action-executions/nope/undo" })).statusCode).toBe(404);
  });
});
