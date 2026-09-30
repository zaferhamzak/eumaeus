import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";
import { buildTestServer } from "./helpers/buildTestServer.js";
import { createTestMembership, createTestUser } from "../helpers/auth.js";
import { createReceivedEmail, createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/db/client.js";
import type { Permission } from "../../src/modules/auth/permissions.js";

async function appWith(tenantId: string, permissions: Permission[]) {
  const user = await createTestUser();
  await createTestMembership(user.id, tenantId, permissions);
  const app = buildServer({ logger: false, authResolver: async () => ({ id: user.id, email: user.email, isSuperAdmin: false }) });
  return (method: "GET" | "POST", url: string, payload?: object) => app.inject({ method, url, headers: { "x-organization-id": tenantId }, ...(payload ? { payload } : {}) });
}

describe("sender lists API (Phase 16)", () => {
  beforeEach(resetDatabase);

  it("adds, lists and removes entries; rejects duplicates and bad patterns", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const added = await app.inject({ method: "POST", url: "/api/v1/sender-lists", payload: { kind: "allow", pattern: "CEO@Acme.com", note: "Boss" } });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ kind: "allow", pattern: "ceo@acme.com", note: "Boss", source: "manual" });

    expect((await app.inject({ method: "POST", url: "/api/v1/sender-lists", payload: { kind: "block", pattern: "ceo@acme.com" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/sender-lists", payload: { kind: "block", pattern: "nope" } })).statusCode).toBe(400);

    const list = await app.inject({ method: "GET", url: "/api/v1/sender-lists" });
    expect(list.json()).toMatchObject({ data: [{ pattern: "ceo@acme.com" }], blockDestinationRef: null });

    expect((await app.inject({ method: "DELETE", url: `/api/v1/sender-lists/${added.json().id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/sender-lists/${added.json().id}` })).statusCode).toBe(404);
  });

  it("reading needs rules:read, changing needs rules:write", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const reader = await appWith(tenant.id, ["rules:read"]);
    expect((await reader("GET", "/api/v1/sender-lists")).statusCode).toBe(200);
    expect((await reader("GET", "/api/v1/routing-suggestions")).statusCode).toBe(200);
    expect((await reader("POST", "/api/v1/sender-lists", { kind: "allow", pattern: "a@b.test" })).statusCode).toBe(403);
  });

  it("suggestions can be refreshed and accepted", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    for (let i = 0; i < 5; i += 1) {
      const e = await createReceivedEmail(tenant.id, mailboxConnection.id, `s${i}`, { fromAddress: "promo@shop.test" });
      await prisma.humanReviewItem.create({ data: { tenantId: tenant.id, emailId: e.id, reason: "unmatched", status: "resolved", resolution: "spam", resolvedAt: new Date() } });
    }
    const app = buildTestServer(tenant.id);
    const refreshed = (await app.inject({ method: "POST", url: "/api/v1/routing-suggestions/refresh" })).json();
    expect(refreshed.data).toEqual([expect.objectContaining({ kind: "block", pattern: "promo@shop.test", spamCount: 5, resolvedCount: 5 })]);

    const accepted = await app.inject({ method: "POST", url: `/api/v1/routing-suggestions/${refreshed.data[0].id}/accept` });
    expect(accepted.json().status).toBe("accepted");
    expect((await app.inject({ method: "POST", url: `/api/v1/routing-suggestions/${refreshed.data[0].id}/accept` })).statusCode).toBe(409);
    expect(await prisma.senderListEntry.count({ where: { pattern: "promo@shop.test", kind: "block" } })).toBe(1);
  });

  it("the organization's block destination is set through the organization", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "PATCH", url: `/api/v1/organizations/${tenant.id}`, payload: { blockDestinationRef: " Spam klasoru " } });
    expect(res.json().blockDestinationRef).toBe("Spam klasoru");
    const cleared = await app.inject({ method: "PATCH", url: `/api/v1/organizations/${tenant.id}`, payload: { blockDestinationRef: null } });
    expect(cleared.json().blockDestinationRef).toBeNull();
  });

  it("simulates a draft entry", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const res = await buildTestServer(tenant.id).inject({ method: "POST", url: "/api/v1/simulations", payload: { target: { type: "sender_entry", entry: { kind: "block", pattern: "promo.test" } } } });
    expect(res.statusCode).toBe(200);
  });
});
