import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import { prisma } from "../../src/db/client.js";
import { getRedisConnection } from "../../src/queue/connection.js";
import { IdleManager, IDLE_STATE_KEY, publishIdleStates, type IdleConnection, type IdleMailbox, type IdleManagerDeps } from "../../src/modules/mail-providers/imap/idle.js";
import { loadIdleMailboxes } from "../../src/runtime/idleRunner.js";
import { applyPollInterval, enqueueIdleSync, getMailboxSyncQueue, IDLE_SYNC_JOB, scheduleMailboxSync, schedulerId } from "../../src/queue/mailboxSyncQueue.js";
import { startMailboxSyncWorker } from "../../src/queue/workers/mailboxSync.worker.js";
import { mailboxHealth } from "../../src/modules/ops/queueHealth.js";
import { FakeImapClient } from "../fixtures/fakeImapClient.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";
import { waitFor } from "../helpers/waitFor.js";

/** A scriptable IMAP connection: connect succeeds unless told otherwise; the test fires new mail and drops. */
class FakeIdleConnection implements IdleConnection {
  static all: FakeIdleConnection[] = [];
  static failNext: unknown[] = [];
  closed = false;
  watched: string | undefined;
  private newMail: Array<() => void> = [];
  private closeListeners: Array<(e?: unknown) => void> = [];
  constructor(readonly mailbox: IdleMailbox) {
    FakeIdleConnection.all.push(this);
  }
  async connect() {
    const failure = FakeIdleConnection.failNext.shift();
    if (failure) throw failure;
  }
  async watch(folder: string) {
    this.watched = folder;
  }
  onNewMail(l: () => void) {
    this.newMail.push(l);
  }
  onClose(l: (e?: unknown) => void) {
    this.closeListeners.push(l);
  }
  async close() {
    this.closed = true;
  }
  fireNewMail() {
    this.newMail.forEach((l) => l());
  }
  drop(error?: unknown) {
    this.closeListeners.forEach((l) => l(error));
  }
}

function mailbox(id: string, overrides: Partial<IdleMailbox["config"]> = {}): IdleMailbox {
  return { id, tenantId: "t", authType: "password", emailAddress: `${id}@x.test`, config: { host: "imap.x.test", port: 993, tls: true, username: id, folder: "INBOX", ...overrides } };
}

function harness(initial: IdleMailbox[], maxConnections = 10, backoffMs = [20, 40]) {
  let current = initial;
  const events: string[] = [];
  const deps: IdleManagerDeps = {
    factory: (m) => new FakeIdleConnection(m),
    resolveSecret: async () => ({ kind: "password", value: "p" }),
    loadMailboxes: async () => current,
    onNewMail: async (id) => void events.push(`mail:${id}`),
    onLiveChange: async (id, live) => void events.push(`${live ? "live" : "notlive"}:${id}`),
    maxConnections,
    backoffMs,
  };
  const manager = new IdleManager(deps);
  return { manager, events, set: (m: IdleMailbox[]) => (current = m) };
}

const stateOf = (manager: IdleManager, id: string) => manager.states().get(id)?.state;

/** 1.1 (C): IMAP IDLE — new mail within seconds, polling as the safety net. */
describe("IDLE manager", () => {
  beforeEach(() => {
    FakeIdleConnection.all = [];
    FakeIdleConnection.failNext = [];
  });

  it("opens one connection per mailbox, parks it on the folder and reports it live; new mail triggers a sync", async () => {
    const h = harness([mailbox("a"), mailbox("b", { folder: "Gelen" })]);
    await h.manager.reconcile();
    await waitFor(() => stateOf(h.manager, "a") === "live" && stateOf(h.manager, "b") === "live");
    expect(FakeIdleConnection.all.map((c) => c.watched)).toEqual(["INBOX", "Gelen"]);
    expect(h.events.sort()).toEqual(["live:a", "live:b"]);

    FakeIdleConnection.all[0]!.fireNewMail();
    await waitFor(() => h.events.includes("mail:a"));
    await h.manager.stop();
  });

  it("a dropped connection stops being live, comes back after the backoff and syncs once to catch up", async () => {
    const h = harness([mailbox("a")]);
    await h.manager.reconcile();
    await waitFor(() => stateOf(h.manager, "a") === "live");
    FakeIdleConnection.all[0]!.drop(new Error("Socket timeout"));
    await waitFor(() => h.events.includes("notlive:a"));
    expect(FakeIdleConnection.all[0]!.closed).toBe(true);
    await waitFor(() => FakeIdleConnection.all.length === 2 && stateOf(h.manager, "a") === "live");
    expect(h.events).toEqual(["live:a", "notlive:a", "live:a", "mail:a"]);
    await h.manager.stop();
  });

  it("keeps retrying a server that refuses the connection, with growing delays", async () => {
    FakeIdleConnection.failNext = [new Error("ECONNREFUSED"), new Error("ECONNREFUSED")];
    const h = harness([mailbox("a")], 10, [100, 200]);
    await h.manager.reconcile();
    await waitFor(() => stateOf(h.manager, "a") === "waiting", 1000, 5);
    await waitFor(() => stateOf(h.manager, "a") === "live", 2000);
    expect(FakeIdleConnection.all).toHaveLength(3);
    // Never live before, so nothing to switch back to normal polling.
    expect(h.events.filter((e) => e.startsWith("notlive"))).toEqual([]);
    await h.manager.stop();
  });

  it("a rejected sign-in waits the longest delay", async () => {
    FakeIdleConnection.failNext = [Object.assign(new Error("Authentication failed"), { authenticationFailed: true })];
    const h = harness([mailbox("a")], 10, [100, 400]);
    await h.manager.reconcile();
    await waitFor(() => stateOf(h.manager, "a") === "waiting", 1000, 5);
    await new Promise((r) => setTimeout(r, 200));
    expect(FakeIdleConnection.all).toHaveLength(1); // not yet: a rejected sign-in waits 400 ms, not 100
    await waitFor(() => stateOf(h.manager, "a") === "live");
    await h.manager.stop();
  });

  it("reconcile closes connections of mailboxes that went away (without touching their polling) and reopens changed ones", async () => {
    const h = harness([mailbox("a"), mailbox("b")]);
    await h.manager.reconcile();
    await waitFor(() => stateOf(h.manager, "a") === "live" && stateOf(h.manager, "b") === "live");

    h.set([mailbox("a", { host: "new.x.test" })]);
    await h.manager.reconcile();
    expect(FakeIdleConnection.all[0]!.closed).toBe(true);
    expect(FakeIdleConnection.all[1]!.closed).toBe(true);
    expect(h.manager.states().has("b")).toBe(false);
    await waitFor(() => stateOf(h.manager, "a") === "live");
    expect(FakeIdleConnection.all.at(-1)!.mailbox.config.host).toBe("new.x.test");
    // A disabled mailbox must not be put back on a poll schedule.
    expect(h.events).not.toContain("notlive:b");
    await h.manager.stop();
  });

  it("opens no more than the connection limit", async () => {
    const h = harness([mailbox("a"), mailbox("b"), mailbox("c")], 2);
    await h.manager.reconcile();
    expect([...h.manager.states().keys()]).toEqual(["a", "b"]);
    await h.manager.stop();
    expect(FakeIdleConnection.all.every((c) => c.closed)).toBe(true);
  });
});

describe("IDLE and the sync queue", () => {
  let worker: Worker | undefined;

  beforeEach(async () => {
    await resetDatabase();
    const queue = getMailboxSyncQueue();
    for (const s of await queue.getJobSchedulers()) await queue.removeJobScheduler(s.key);
    await queue.obliterate({ force: true });
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    const queue = getMailboxSyncQueue();
    for (const s of await queue.getJobSchedulers()) await queue.removeJobScheduler(s.key);
    await queue.obliterate({ force: true });
    await getRedisConnection().del(IDLE_STATE_KEY);
  });

  it("slows polling while live and restores it after, but never schedules an unscheduled mailbox", async () => {
    const queue = getMailboxSyncQueue();
    await scheduleMailboxSync("m1", 60_000);
    await applyPollInterval("m1", true, 60_000, 300_000);
    expect((await queue.getJobScheduler(schedulerId("m1")))?.every).toBe(300_000);
    await applyPollInterval("m1", false, 60_000, 300_000);
    expect((await queue.getJobScheduler(schedulerId("m1")))?.every).toBe(60_000);

    // BullMQ answers a missing "mailbox-sync:…" scheduler with a made-up entry without `every`.
    await applyPollInterval("m2", true, 60_000, 300_000);
    expect((await queue.getJobSchedulers()).map((s) => s.key)).toEqual([schedulerId("m1")]);
  });

  it("a burst of new-mail signals becomes one sync job", async () => {
    await Promise.all([enqueueIdleSync("m1"), enqueueIdleSync("m1"), enqueueIdleSync("m1")]);
    const jobs = (await getMailboxSyncQueue().getJobs(["waiting", "delayed"])).filter((j) => j.name === IDLE_SYNC_JOB);
    expect(jobs.length).toBeLessThanOrEqual(2); // one per 2-second window; a burst can straddle a boundary
    expect(jobs.length).toBeGreaterThanOrEqual(1);
  });

  it("an IDLE sync that meets a running sync of the same mailbox is re-queued once", async () => {
    const { mailboxConnection } = await createTestTenantAndMailbox();
    await prisma.mailboxConnection.update({ where: { id: mailboxConnection.id }, data: { syncStatus: "syncing", syncLockedAt: new Date() } });
    worker = startMailboxSyncWorker(() => new FakeImapClient({ uidValidity: 1, uidNext: 1, messages: [] }));
    await enqueueIdleSync(mailboxConnection.id);
    await waitFor(async () => (await getMailboxSyncQueue().getJobs(["delayed"])).some((j) => j.data.retried === true));
  });

  it("loads only active mailboxes of active organizations", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const other = await prisma.mailboxConnection.create({
      data: { tenantId: tenant.id, name: "Off", provider: "imap", emailAddress: "off@x.test", providerConfig: { host: "h", port: 993, tls: true, folder: "INBOX", username: "off" }, status: "disabled" },
    });
    expect((await loadIdleMailboxes()).map((m) => m.id)).toEqual([mailboxConnection.id]);
    await prisma.tenant.update({ where: { id: tenant.id }, data: { status: "inactive" } });
    expect(await loadIdleMailboxes()).toEqual([]);
    expect(other.id).toBeTruthy();
  });

  it("mailbox health shows which mailboxes are live", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    expect((await mailboxHealth(tenant.id))[0]!.live).toBe(false);
    await publishIdleStates(getRedisConnection(), new Map([[mailboxConnection.id, { state: "live" as const, since: new Date() }]]));
    expect((await mailboxHealth(tenant.id))[0]!.live).toBe(true);
    await publishIdleStates(getRedisConnection(), new Map([[mailboxConnection.id, { state: "waiting" as const, since: new Date() }]]));
    expect((await mailboxHealth(tenant.id))[0]!.live).toBe(false);
  });
});
