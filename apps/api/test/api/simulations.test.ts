import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";
import { buildTestServer } from "./helpers/buildTestServer.js";
import { createTestMembership, createTestUser } from "../helpers/auth.js";
import { createReceivedEmail, createSuccessfulAnalysis, createTestTenantAndMailbox, defaultAnswers, resetDatabase } from "../helpers/db.js";
import type { Permission } from "../../src/modules/auth/permissions.js";

const RULE = { name: "Marketing", priority: 20, conditions: { field: "answers.category", op: "==", value: "marketing" }, destinationRef: "marketing" };

async function appWith(tenantId: string, permissions: Permission[]) {
  const user = await createTestUser();
  await createTestMembership(user.id, tenantId, permissions);
  const app = buildServer({ logger: false, authResolver: async () => ({ id: user.id, email: user.email, isSuperAdmin: false }) });
  return (payload: unknown) => app.inject({ method: "POST", url: "/api/v1/simulations", headers: { "x-organization-id": tenantId }, payload: payload as object });
}

describe("POST /api/v1/simulations", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("simulates a draft rule", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
    await createSuccessfulAnalysis(tenant.id, email.id, defaultAnswers({ category: { choice: "marketing", probabilities: {}, confidence: 0.9 } }));

    const res = await buildTestServer(tenant.id).inject({ method: "POST", url: "/api/v1/simulations", payload: { target: { type: "rule", rule: RULE }, scope: { limit: 50 } } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ evaluated: 1, draftMatched: 1, changed: 1, byDestination: [{ destinationRef: "marketing", count: 1 }] });
  });

  it("needs both rules:read and emails:read", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    expect((await (await appWith(tenant.id, ["rules:read"]))({ target: { type: "rule", rule: RULE } })).statusCode).toBe(403);
    expect((await (await appWith(tenant.id, ["emails:read"]))({ target: { type: "rule", rule: RULE } })).statusCode).toBe(403);
    expect((await (await appWith(tenant.id, ["rules:read", "emails:read"]))({ target: { type: "rule", rule: RULE } })).statusCode).toBe(200);
  });

  it("400s an invalid draft and an out-of-range limit", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const badField = await app.inject({ method: "POST", url: "/api/v1/simulations", payload: { target: { type: "rule", rule: { ...RULE, conditions: { field: "nope", op: "==", value: 1 } } } } });
    expect(badField.statusCode).toBe(400);
    const tooMany = await app.inject({ method: "POST", url: "/api/v1/simulations", payload: { target: { type: "rule", rule: RULE }, scope: { limit: 5000 } } });
    expect(tooMany.statusCode).toBe(400);
  });

  it("rules list carries match statistics", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    await app.inject({ method: "POST", url: "/api/v1/rules", payload: RULE });
    const list = await app.inject({ method: "GET", url: "/api/v1/rules" });
    expect(list.json().data[0].stats).toEqual({ matchesLast7Days: 0, matchesLast30Days: 0, evaluationsLast30Days: 0, lastMatchedAt: null });
  });
});
