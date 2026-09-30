import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import { prisma } from "../../src/db/client.js";
import {
  getMailboxSyncQueue,
  scheduleMailboxSync,
  unscheduleMailboxSync,
  schedulerId,
} from "../../src/queue/mailboxSyncQueue.js";
import { startMailboxSyncWorker } from "../../src/queue/workers/mailboxSync.worker.js";
import { FakeImapClient } from "../fixtures/fakeImapClient.js";
import { BASIC_MESSAGE } from "../fixtures/rawMessages.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";
import { waitFor } from "../helpers/waitFor.js";

describe("reconciliation scheduler", () => {
  let activeWorker: Worker | undefined;
  let activeMailboxId: string | undefined;

  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(async () => {
    // Close the worker FIRST: a running worker can complete a job and have BullMQ
    // auto-advance its job scheduler to the next tick (creating a fresh,
    // differently-timestamped repeat entry) at any moment, including between this
    // hook's own statements — closing it stops that from happening mid-cleanup.
    if (activeWorker) {
      await activeWorker.close();
    }
    if (activeMailboxId) {
      await unscheduleMailboxSync(activeMailboxId);
    }
    // Defensive sweep, not just the one scheduler this test registered: a 1s-tick
    // schedule can have already advanced BEFORE the worker closed above (a job
    // already fully completed inside this test's own `waitFor`, well before
    // afterEach runs at all), which can leave a scheduler behind that
    // unscheduleMailboxSync's single targeted removal doesn't catch. Removing
    // every currently-registered scheduler on this test-only queue after each
    // test is safe and is what actually guarantees zero cross-test leakage.
    const queue = getMailboxSyncQueue();
    const schedulers = await queue.getJobSchedulers();
    await Promise.all(schedulers.map((s) => queue.removeJobScheduler(s.key)));
    await queue.drain(true);
    activeMailboxId = undefined;
    activeWorker = undefined;
  });

  it("registers a durable, Redis-backed repeating schedule for the mailbox", async () => {
    const { mailboxConnection } = await createTestTenantAndMailbox();
    activeMailboxId = mailboxConnection.id;

    await scheduleMailboxSync(mailboxConnection.id, 60_000);

    const schedulers = await getMailboxSyncQueue().getJobSchedulers();
    const ours = schedulers.find((s) => s.key === schedulerId(mailboxConnection.id));
    expect(ours).toBeDefined();
    expect(ours?.every).toBe(60_000);
    expect(ours?.template?.data).toEqual({ mailboxConnectionId: mailboxConnection.id });
  });

  it("scheduling the same mailbox multiple times does not create duplicate schedules", async () => {
    const { mailboxConnection } = await createTestTenantAndMailbox();
    activeMailboxId = mailboxConnection.id;

    await scheduleMailboxSync(mailboxConnection.id, 60_000);
    await scheduleMailboxSync(mailboxConnection.id, 60_000);
    await scheduleMailboxSync(mailboxConnection.id, 60_000);

    const schedulers = await getMailboxSyncQueue().getJobSchedulers();
    const ours = schedulers.filter((s) => s.key === schedulerId(mailboxConnection.id));
    expect(ours).toHaveLength(1);
  });

  it("a scheduled tick actually runs syncMailbox() and discovers new mail — end to end", async () => {
    const { mailboxConnection } = await createTestTenantAndMailbox();
    activeMailboxId = mailboxConnection.id;

    const fakeClientFactory = () =>
      new FakeImapClient({ uidValidity: 1, uidNext: 5, messages: [{ uid: 1, source: BASIC_MESSAGE }] });

    activeWorker = startMailboxSyncWorker(fakeClientFactory);
    // BullMQ's minimum practical repeat granularity is ~1s; the schedule fires once
    // the first interval elapses (no `immediately` option for plain `every`).
    await scheduleMailboxSync(mailboxConnection.id, 1000);

    await waitFor(async () => {
      const count = await prisma.email.count({ where: { mailboxConnectionId: mailboxConnection.id } });
      return count === 1;
    }, 8000);

    const refreshed = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: mailboxConnection.id } });
    expect(refreshed.syncStatus).toBe("idle");
    expect(refreshed.lastSyncSuccessAt).not.toBeNull();

    const completedEvents = await prisma.auditEvent.findMany({
      where: { tenantId: mailboxConnection.tenantId, eventType: "mailbox_sync_completed" },
    });
    expect(completedEvents.length).toBeGreaterThanOrEqual(1);
  }, 15000);
});
