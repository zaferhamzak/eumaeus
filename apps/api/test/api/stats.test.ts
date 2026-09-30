import { beforeEach, describe, expect, it } from "vitest";
import { buildTestServer } from "./helpers/buildTestServer.js";
import {
  createMatchedRoutingDecision,
  createReceivedEmail,
  createSuccessfulAnalysis,
  createTestTenantAndMailbox,
  createWebhookDestination,
  defaultAnswers,
  resetDatabase,
} from "../helpers/db.js";
import { prisma } from "../../src/db/client.js";

describe("API — GET /api/v1/stats", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("returns real, tenant-scoped counts by state — zero for an empty tenant", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "GET", url: "/api/v1/stats" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.emails.received).toBe(0);
    expect(body.actions.pending).toBe(0);
    expect(body.review.open).toBe(0);
    expect(body.mailboxes.active).toBe(1); // the bootstrap mailbox itself
    await app.close();
  });

  it("reflects real rows, grouped correctly by state", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
    const email2 = await createReceivedEmail(tenant.id, mailboxConnection.id, "2");
    await prisma.email.update({ where: { id: email2.id }, data: { state: "awaiting_review" } });
    await prisma.humanReviewItem.create({ data: { tenantId: tenant.id, emailId: email2.id, reason: "unmatched", status: "open" } });

    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "GET", url: "/api/v1/stats" });
    const body = res.json();
    expect(body.emails.received).toBe(1);
    expect(body.emails.awaiting_review).toBe(1);
    expect(body.review.open).toBe(1);
    await app.close();
  });

  it("is strictly tenant-scoped — another tenant's rows never leak into these counts", async () => {
    const { tenant: tenantA } = await createTestTenantAndMailbox();
    const { tenant: tenantB, mailboxConnection: mailboxB } = await createTestTenantAndMailbox();
    await createReceivedEmail(tenantB.id, mailboxB.id, "1");

    const appA = buildTestServer(tenantA.id);
    const res = await appA.inject({ method: "GET", url: "/api/v1/stats" });
    expect(res.json().emails.received).toBe(0);
    await appA.close();
  });

  it("counts action executions by status", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
    const analysis = await createSuccessfulAnalysis(tenant.id, email.id, defaultAnswers());
    const { destination, channel } = await createWebhookDestination(tenant.id, "hooks", "https://hooks.example.com/x");
    const routingDecision = await createMatchedRoutingDecision(tenant.id, email.id, destination.name, analysis.id);
    await prisma.actionExecution.create({
      data: {
        tenantId: tenant.id,
        emailId: email.id,
        routingDecisionId: routingDecision.id,
        destinationChannelId: channel.id,
        channelType: "webhook",
        channelVersion: 1,
        idempotencyKey: "k1",
        attemptNumber: 1,
        status: "ambiguous",
      },
    });

    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "GET", url: "/api/v1/stats" });
    expect(res.json().actions.ambiguous).toBe(1);
    await app.close();
  });
});
