import { beforeEach, describe, expect, it } from "vitest";
import { Worker } from "bullmq";
import { getRedisConnection } from "../../src/queue/connection.js";
import { prisma } from "../../src/db/client.js";
import { cleanupSyncJobs, mailboxHealth, queueHealth } from "../../src/modules/ops/queueHealth.js";
import { getMailboxSyncQueue, scheduleMailboxSync, schedulerId } from "../../src/queue/mailboxSyncQueue.js";
import { buildServer } from "../../src/api/server.js";
import { buildTestServer } from "../api/helpers/buildTestServer.js";
import { createTestMembership, createTestUser } from "../helpers/auth.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";

async function failedJob(mailboxConnectionId: string) {
  // A job the way a worker fails it: taken (active), then failed with no retries left.
  const q = getMailboxSyncQueue();
  await q.add("sync", { mailboxConnectionId }, { jobId: `t-${mailboxConnectionId}`, attempts: 1 });
  const worker = new Worker(q.name, null, { connection: getRedisConnection(), autorun: false });
  const job = await worker.getNextJob("test-token");
  await job!.moveToFailed(new Error("Command failed"), "test-token", false);
  await worker.close();
}

describe("Phase 26 — sync health", () => {
  beforeEach(async () => {
    await resetDatabase();
    await getMailboxSyncQueue().obliterate({ force: true });
  });

  it("orders an organization's mailboxes by health, problems first", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const fine = await prisma.mailboxConnection.create({ data: { tenantId: tenant.id, name: "Fine", provider: "imap", emailAddress: "fine@x.test", providerConfig: {}, status: "active", lastSyncSuccessAt: new Date() } });
    await prisma.mailboxConnection.update({ where: { id: mailboxConnection.id }, data: { lastSyncSuccessAt: new Date(Date.now() - 3600_000), lastSyncFailureAt: new Date(), lastSyncError: "Command failed" } });
    const rows = await mailboxHealth(tenant.id);
    expect(rows.map((r) => [r.emailAddress, r.health])).toEqual([["bob@eumaeus.test", "failing"], ["fine@x.test", "ok"]]);
    expect(rows[0]!.lastSyncError).toBe("Command failed");
    void fine;
    const app = buildTestServer(tenant.id);
    expect((await app.inject({ method: "GET", url: "/api/v1/mailboxes/health" })).json().data).toHaveLength(2);
  });

  it("cleanup drops failed jobs of missing/disabled mailboxes and schedules of missing ones, keeps the rest", async () => {
    const { mailboxConnection } = await createTestTenantAndMailbox();
    await failedJob(mailboxConnection.id);
    await failedJob("00000000-0000-0000-0000-00000000dead");
    await scheduleMailboxSync(mailboxConnection.id, 60_000);
    await scheduleMailboxSync("00000000-0000-0000-0000-00000000dead", 60_000);

    const result = await cleanupSyncJobs();
    expect(result).toMatchObject({ removedOrphaned: 1, removedSchedules: 1 });
    const q = getMailboxSyncQueue();
    const left = (await q.getFailed(0, 100)).map((j) => j?.data.mailboxConnectionId);
    expect(left).toEqual([mailboxConnection.id]);
    expect((await q.getJobSchedulers(0, 100)).map((s) => s.key)).toEqual([schedulerId(mailboxConnection.id)]);

    await prisma.mailboxConnection.update({ where: { id: mailboxConnection.id }, data: { status: "disabled" } });
    expect((await cleanupSyncJobs()).removedOrphaned).toBe(1);
    // A disabled mailbox keeps its schedule (sync skips it; re-enabling resumes).
    expect(await q.getJobSchedulersCount()).toBe(1);
  });

  it("1.0: failed jobs of a mailbox waiting for a new password are cleaned up too", async () => {
    const { mailboxConnection } = await createTestTenantAndMailbox();
    await failedJob(mailboxConnection.id);
    await prisma.mailboxConnection.update({ where: { id: mailboxConnection.id }, data: { status: "reauth_required" } });
    expect((await cleanupSyncJobs()).removedOrphaned).toBe(1);
    expect(await getMailboxSyncQueue().getFailedCount()).toBe(0);
  });

  it("queue health lists every queue with counts; only a superAdmin may read it", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    await failedJob(mailboxConnection.id);
    const health = await queueHealth();
    const sync = health.find((q) => q.name === "mailbox-sync")!;
    expect(sync.counts.failed).toBe(1);
    expect(sync.recentFailures[0]).toMatchObject({ reason: "Command failed", mailboxConnectionId: mailboxConnection.id });
    expect(health.map((q) => q.name)).toEqual(expect.arrayContaining(["process-email", "execute-action", "maintenance"]));

    const user = await createTestUser();
    await createTestMembership(user.id, tenant.id, ["mailboxes:read"]);
    const member = buildServer({ logger: false, authResolver: async () => ({ id: user.id, email: user.email, isSuperAdmin: false }) });
    expect((await member.inject({ method: "GET", url: "/api/v1/admin/queues" })).statusCode).toBe(403);
    const admin = buildServer({ logger: false, authResolver: async () => ({ id: "root", email: "root@x", isSuperAdmin: true }) });
    expect((await admin.inject({ method: "GET", url: "/api/v1/admin/queues" })).statusCode).toBe(200);
  });
});
