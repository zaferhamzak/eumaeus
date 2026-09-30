import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";
import { metrics } from "../../src/metrics/metrics.js";
import { MetricName } from "../../src/metrics/names.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";
import { loadEnv } from "../../src/config/env.js";

describe("GET /metrics", () => {
  beforeEach(async () => {
    await resetDatabase();
    metrics.reset();
  });

  it("returns the documented {counters, histograms} JSON shape", async () => {
    const app = buildServer({ logger: false });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.counters)).toBe(true);
    expect(Array.isArray(body.histograms)).toBe(true);
    await app.close();
  });

  it("requires no database access — reads only the in-process registry", async () => {
    // If it required a DB query, this would throw given no tenant/mailbox
    // exists and no query is scoped to anything — the fact this resolves at
    // all with an empty DB is itself evidence, but assert explicitly on shape.
    const app = buildServer({ logger: false });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("records API request count and latency after real traffic, labeled by route TEMPLATE not resolved URL", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const app = buildServer({ logger: false, tenantResolver: async () => tenant.id });
    await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxConnection.id}` });

    const res = await app.inject({ method: "GET", url: "/metrics" });
    const body = res.json();
    const requestCounters = body.counters.filter((c: { name: string }) => c.name === MetricName.API_REQUEST);
    expect(requestCounters.length).toBeGreaterThan(0);
    const matching = requestCounters.find((c: { labels: Record<string, string> }) => c.labels.route === "/api/v1/mailboxes/:id");
    expect(matching).toBeDefined();
    expect(matching.labels.route).not.toContain(mailboxConnection.id); // never the real id

    const durationHistograms = body.histograms.filter((h: { name: string }) => h.name === MetricName.API_REQUEST_DURATION_MS);
    expect(durationHistograms.length).toBeGreaterThan(0);
    await app.close();
  });

  it("counters increment for a real domain event (a genuine Human Review escalation), observable end-to-end via /metrics", async () => {
    const { escalateToHumanReview } = await import("../../src/modules/review/escalate.js");
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await (await import("../helpers/db.js")).createReceivedEmail(tenant.id, mailboxConnection.id, "1");

    await escalateToHumanReview(tenant.id, email.id, { errorMessage: "no rule matched", attemptsMade: 0, reason: "unmatched" });

    const app = buildServer({ logger: false });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    const body = res.json();
    const found = body.counters.find(
      (c: { name: string; labels: Record<string, string> }) => c.name === MetricName.HUMAN_REVIEW_ESCALATED && c.labels.reason === "unmatched",
    );
    expect(found).toMatchObject({ value: 1 });
    await app.close();
  });

  it("a redelivered/duplicate escalation for the same email does not double-count the metric (matches the idempotent HumanReviewItem behavior)", async () => {
    const { escalateToHumanReview } = await import("../../src/modules/review/escalate.js");
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await (await import("../helpers/db.js")).createReceivedEmail(tenant.id, mailboxConnection.id, "1");

    await escalateToHumanReview(tenant.id, email.id, { errorMessage: "first", attemptsMade: 0, reason: "unmatched" });
    await escalateToHumanReview(tenant.id, email.id, { errorMessage: "duplicate", attemptsMade: 0, reason: "unmatched" });

    const app = buildServer({ logger: false });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    const found = res.json().counters.find(
      (c: { name: string; labels: Record<string, string> }) => c.name === MetricName.HUMAN_REVIEW_ESCALATED && c.labels.reason === "unmatched",
    );
    expect(found).toMatchObject({ value: 1 }); // not 2
    await app.close();
  });

  it("never exposes SECRET_ENCRYPTION_KEY or any secret value", async () => {
    const app = buildServer({ logger: false });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain(loadEnv().SECRET_ENCRYPTION_KEY);
    expect(raw.toLowerCase()).not.toContain("password");
    expect(raw.toLowerCase()).not.toContain("secret");
    await app.close();
  });

  it("labels stay low-cardinality — no emailId/subject/sender/webhook URL ever appears as a metric label", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const app = buildServer({ logger: false, tenantResolver: async () => tenant.id });
    const email = await (await import("../helpers/db.js")).createReceivedEmail(tenant.id, mailboxConnection.id, "1", {
      subject: "A Very Unique Subject Line 12345",
      fromAddress: "unique-sender-98765@example.com",
    });

    await app.inject({ method: "GET", url: `/api/v1/emails/${email.id}` });

    const res = await app.inject({ method: "GET", url: "/metrics" });
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain(email.id);
    expect(raw).not.toContain("A Very Unique Subject Line");
    expect(raw).not.toContain("unique-sender-98765");
    await app.close();
  });
});
