import { beforeEach, describe, expect, it } from "vitest";
import { buildTestServer } from "./helpers/buildTestServer.js";
import {
  createArchiveDestination,
  createMatchedRoutingDecision,
  createReceivedEmail,
  createSuccessfulAnalysis,
  createTestTenantAndMailbox,
  defaultAnswers,
  resetDatabase,
} from "../helpers/db.js";

describe("API — routing decisions", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("lists routing decisions for the current tenant", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
    const analysis = await createSuccessfulAnalysis(tenant.id, email.id, defaultAnswers());
    const { destination } = await createArchiveDestination(tenant.id, "sales");
    await createMatchedRoutingDecision(tenant.id, email.id, destination.name, analysis.id);
    const app = buildTestServer(tenant.id);

    const res = await app.inject({ method: "GET", url: "/api/v1/routing-decisions" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    await app.close();
  });

  it("gets routing decision detail by id", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
    const analysis = await createSuccessfulAnalysis(tenant.id, email.id, defaultAnswers());
    const { destination } = await createArchiveDestination(tenant.id, "sales");
    const decision = await createMatchedRoutingDecision(tenant.id, email.id, destination.name, analysis.id);
    const app = buildTestServer(tenant.id);

    const res = await app.inject({ method: "GET", url: `/api/v1/routing-decisions/${decision.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: decision.id, destinationRef: "sales", status: "matched" });
    await app.close();
  });

  it("a routing decision belonging to a different tenant is not found", async () => {
    const { tenant: tenantA } = await createTestTenantAndMailbox();
    const { tenant: tenantB, mailboxConnection: mailboxB } = await createTestTenantAndMailbox();
    const emailB = await createReceivedEmail(tenantB.id, mailboxB.id, "1");
    const analysisB = await createSuccessfulAnalysis(tenantB.id, emailB.id, defaultAnswers());
    const { destination } = await createArchiveDestination(tenantB.id, "sales");
    const decisionB = await createMatchedRoutingDecision(tenantB.id, emailB.id, destination.name, analysisB.id);

    const appA = buildTestServer(tenantA.id);
    const res = await appA.inject({ method: "GET", url: `/api/v1/routing-decisions/${decisionB.id}` });
    expect(res.statusCode).toBe(404);
    await appA.close();
  });
});
