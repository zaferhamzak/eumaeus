import { Worker } from "bullmq";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { computeIdempotencyKey } from "../../src/modules/destinations/idempotency.js";
import { EXECUTE_ACTION_QUEUE, getExecuteActionQueue, type ExecuteActionJobData } from "../../src/queue/executeActionQueue.js";
import { getRedisConnection } from "../../src/queue/connection.js";

async function setup() {
  const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
  const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
  const analysis = await createSuccessfulAnalysis(tenant.id, email.id, defaultAnswers());
  const { destination, channel } = await createWebhookDestination(tenant.id, "hooks", "https://hooks.example.com/incoming");
  const routingDecision = await createMatchedRoutingDecision(tenant.id, email.id, destination.name, analysis.id);
  const idempotencyKey = computeIdempotencyKey(email.id, routingDecision.id, channel.id);
  return { tenant, email, destination, channel, routingDecision, idempotencyKey };
}

async function createExecutionRow(overrides: {
  tenantId: string;
  emailId: string;
  routingDecisionId: string;
  destinationChannelId: string;
  idempotencyKey: string;
  status: string;
  retryable?: boolean | null;
}) {
  return prisma.actionExecution.create({
    data: {
      tenantId: overrides.tenantId,
      emailId: overrides.emailId,
      routingDecisionId: overrides.routingDecisionId,
      destinationChannelId: overrides.destinationChannelId,
      channelType: "webhook",
      channelVersion: 1,
      idempotencyKey: overrides.idempotencyKey,
      attemptNumber: 1,
      status: overrides.status,
      retryable: overrides.retryable ?? null,
    },
  });
}

/** Drives a real BullMQ job (jobId = idempotencyKey) to the "failed" state via a throwing worker with attempts:1 — a genuine failed job, not a simulated one, so the API's job.retry() call exercises the real thing. */
async function enqueueAndFailJob(idempotencyKey: string, data: ExecuteActionJobData): Promise<void> {
  await getExecuteActionQueue().add("execute", data, { jobId: idempotencyKey, attempts: 1, removeOnFail: false });
  const worker = new Worker(
    EXECUTE_ACTION_QUEUE,
    async () => {
      throw new Error("intentional failure to drive this job to the failed state");
    },
    { connection: getRedisConnection() },
  );
  await new Promise<void>((resolve) => {
    worker.on("failed", () => resolve());
  });
  await worker.close();
}

describe("API — action executions", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(async () => {
    // Clean up any leftover BullMQ jobs this suite created, so state never leaks between test files.
    const queue = getExecuteActionQueue();
    const jobs = await queue.getJobs(["waiting", "failed", "active", "completed", "delayed"]);
    await Promise.all(jobs.map((job) => job.remove().catch(() => {})));
  });

  it("lists action executions, optionally filtered by status", async () => {
    const { tenant, email, routingDecision, channel } = await setup();
    await createExecutionRow({ tenantId: tenant.id, emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey: "k1", status: "succeeded" });
    await createExecutionRow({ tenantId: tenant.id, emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey: "k2", status: "failed", retryable: true });
    const app = buildTestServer(tenant.id);

    const all = await app.inject({ method: "GET", url: "/api/v1/action-executions" });
    expect(all.json().data).toHaveLength(2);

    const failedOnly = await app.inject({ method: "GET", url: "/api/v1/action-executions?status=failed" });
    expect(failedOnly.json().data).toHaveLength(1);
    expect(failedOnly.json().data[0].status).toBe("failed");
    await app.close();
  });

  it("gets execution detail by id", async () => {
    const { tenant, email, routingDecision, channel } = await setup();
    const row = await createExecutionRow({ tenantId: tenant.id, emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey: "k1", status: "succeeded" });
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "GET", url: `/api/v1/action-executions/${row.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(row.id);
    await app.close();
  });

  it("retries a genuinely failed+retryable execution by resuming the real BullMQ job (Job.retry()), not by invoking an executor directly", async () => {
    const { tenant, email, routingDecision, channel, idempotencyKey } = await setup();
    const row = await createExecutionRow({
      tenantId: tenant.id,
      emailId: email.id,
      routingDecisionId: routingDecision.id,
      destinationChannelId: channel.id,
      idempotencyKey,
      status: "failed",
      retryable: true,
    });
    await enqueueAndFailJob(idempotencyKey, { emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey });

    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "POST", url: `/api/v1/action-executions/${row.id}/retry` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(row.id);

    const job = await getExecuteActionQueue().getJob(idempotencyKey);
    expect(await job?.getState()).not.toBe("failed"); // moved back to waiting/active by Job.retry()
    await app.close();
  });

  it("rejects retrying a succeeded execution", async () => {
    const { tenant, email, routingDecision, channel } = await setup();
    const row = await createExecutionRow({ tenantId: tenant.id, emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey: "k-succeeded", status: "succeeded" });
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "POST", url: `/api/v1/action-executions/${row.id}/retry` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "INVALID_STATE" } });
    await app.close();
  });

  it("rejects retrying an ambiguous execution (never auto-retried)", async () => {
    const { tenant, email, routingDecision, channel } = await setup();
    const row = await createExecutionRow({ tenantId: tenant.id, emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey: "k-ambiguous", status: "ambiguous" });
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "POST", url: `/api/v1/action-executions/${row.id}/retry` });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("rejects retrying a permanently-failed (retryable=false) execution", async () => {
    const { tenant, email, routingDecision, channel } = await setup();
    const row = await createExecutionRow({ tenantId: tenant.id, emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey: "k-permanent", status: "failed", retryable: false });
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "POST", url: `/api/v1/action-executions/${row.id}/retry` });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("rejects retrying a failed+retryable execution whose BullMQ job no longer exists", async () => {
    const { tenant, email, routingDecision, channel } = await setup();
    const row = await createExecutionRow({ tenantId: tenant.id, emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey: "k-no-job", status: "failed", retryable: true });
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "POST", url: `/api/v1/action-executions/${row.id}/retry` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain("No queued job");
    await app.close();
  });

  it("retrying an unknown execution is 404", async () => {
    const { tenant } = await setup();
    const app = buildTestServer(tenant.id);
    const res = await app.inject({ method: "POST", url: "/api/v1/action-executions/does-not-exist/retry" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("an execution belonging to a different tenant cannot be retried", async () => {
    const { tenant: tenantA } = await setup();
    const { tenant: tenantB, email, routingDecision, channel, idempotencyKey } = await setup();
    const row = await createExecutionRow({ tenantId: tenantB.id, emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey, status: "failed", retryable: true });
    await enqueueAndFailJob(idempotencyKey, { emailId: email.id, routingDecisionId: routingDecision.id, destinationChannelId: channel.id, idempotencyKey });

    const appA = buildTestServer(tenantA.id);
    const res = await appA.inject({ method: "POST", url: `/api/v1/action-executions/${row.id}/retry` });
    expect(res.statusCode).toBe(404);
    await appA.close();
  });
});
