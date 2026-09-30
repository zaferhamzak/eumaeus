import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { releaseActiveSyncLocks, syncMailbox } from "../../src/modules/mail-providers/imap/sync.js";
import { FakeImapClient } from "../fixtures/fakeImapClient.js";
import { BASIC_MESSAGE, WITH_ATTACHMENT } from "../fixtures/rawMessages.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";

describe("concurrency — two syncMailbox() calls for the SAME mailbox must not race", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("only one of two concurrent syncs actually runs; the other is skipped, and no emails are duplicated", async () => {
    const { mailboxConnection } = await createTestTenantAndMailbox();

    // fetchDelayMs widens the window the lock is held for, long enough that a truly
    // concurrent second call reliably observes it still held.
    const slowClient = () =>
      new FakeImapClient({
        uidValidity: 1,
        uidNext: 50,
        fetchDelayMs: 40,
        messages: [
          { uid: 1, source: BASIC_MESSAGE },
          { uid: 2, source: WITH_ATTACHMENT },
        ],
      });

    const [resultA, resultB] = await Promise.all([
      syncMailbox(mailboxConnection.id, slowClient),
      syncMailbox(mailboxConnection.id, slowClient),
    ]);

    const results = [resultA, resultB];
    const completed = results.filter((r) => !r.skipped);
    const skipped = results.filter((r) => r.skipped);

    expect(completed).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.skipReason).toBe("concurrent_sync_in_progress");
    expect(completed[0]?.discovered).toBe(2);

    const emails = await prisma.email.findMany({ where: { mailboxConnectionId: mailboxConnection.id } });
    expect(emails).toHaveLength(2);

    const skippedEvents = await prisma.auditEvent.findMany({
      where: { tenantId: mailboxConnection.tenantId, eventType: "mailbox_sync_skipped_concurrent" },
    });
    expect(skippedEvents).toHaveLength(1);

    // The mailbox ends up in a clean, correct resting state regardless of which of
    // the two calls "won."
    const refreshed = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: mailboxConnection.id } });
    expect(refreshed.syncStatus).toBe("idle");
    expect(refreshed.syncLockedAt).toBeNull();
    expect(refreshed.lastSyncSuccessAt).not.toBeNull();
    expect(refreshed.lastSyncedUid).toBe(2);
  });

  it("a lock abandoned by a crashed worker is reclaimed after it goes stale, instead of blocking forever", async () => {
    const { mailboxConnection } = await createTestTenantAndMailbox();

    // Simulate a worker that acquired the lock and then crashed without releasing
    // it: syncStatus stuck at "syncing" with an old timestamp.
    await prisma.mailboxConnection.update({
      where: { id: mailboxConnection.id },
      data: { syncStatus: "syncing", syncLockedAt: new Date(Date.now() - 11 * 60 * 1000) },
    });

    const client = () => new FakeImapClient({ uidValidity: 1, uidNext: 5, messages: [{ uid: 1, source: BASIC_MESSAGE }] });
    const result = await syncMailbox(mailboxConnection.id, client);

    expect(result.skipped).toBe(false);
    expect(result.discovered).toBe(1);

    const refreshed = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: mailboxConnection.id } });
    expect(refreshed.syncStatus).toBe("idle");
  });

  it("a lock held recently (not stale) is respected — the second caller is skipped, not blocked/queued", async () => {
    const { mailboxConnection } = await createTestTenantAndMailbox();

    await prisma.mailboxConnection.update({
      where: { id: mailboxConnection.id },
      data: { syncStatus: "syncing", syncLockedAt: new Date() },
    });

    const client = () => new FakeImapClient({ uidValidity: 1, uidNext: 5, messages: [{ uid: 1, source: BASIC_MESSAGE }] });
    const result = await syncMailbox(mailboxConnection.id, client);

    expect(result.skipped).toBe(true);
    const emailCount = await prisma.email.count({ where: { mailboxConnectionId: mailboxConnection.id } });
    expect(emailCount).toBe(0);
  });

  it("a deleted mailbox is skipped (never connects, never throws), so its leftover repeat job can't retry forever", async () => {
    let connected = false;
    const client = () => {
      connected = true;
      return new FakeImapClient({ uidValidity: 1, uidNext: 2, messages: [{ uid: 1, source: BASIC_MESSAGE }] });
    };
    const result = await syncMailbox("00000000-0000-0000-0000-000000000000", client);
    expect(result).toMatchObject({ skipped: true, skipReason: "mailbox_deleted" });
    expect(connected).toBe(false);
  });

  it("a disabled mailbox is skipped and ingests nothing; re-enabled, it syncs again", async () => {
    const { mailboxConnection } = await createTestTenantAndMailbox();
    await prisma.mailboxConnection.update({ where: { id: mailboxConnection.id }, data: { status: "disabled" } });
    let connected = false;
    const client = () => {
      connected = true;
      return new FakeImapClient({ uidValidity: 1, uidNext: 2, messages: [{ uid: 1, source: BASIC_MESSAGE }] });
    };
    expect(await syncMailbox(mailboxConnection.id, client)).toMatchObject({ skipped: true, skipReason: "mailbox_disabled" });
    expect(connected).toBe(false);
    expect(await prisma.email.count()).toBe(0);

    await prisma.mailboxConnection.update({ where: { id: mailboxConnection.id }, data: { status: "active" } });
    expect((await syncMailbox(mailboxConnection.id, client)).skipped).toBeFalsy();
    expect(await prisma.email.count()).toBe(1);
  });

  it("1.0: a lock nobody refreshed for over two minutes is reclaimed (a restart mid-sync no longer silences a mailbox for ten)", async () => {
    const { mailboxConnection } = await createTestTenantAndMailbox();
    await prisma.mailboxConnection.update({ where: { id: mailboxConnection.id }, data: { syncStatus: "syncing", syncLockedAt: new Date(Date.now() - 3 * 60 * 1000) } });
    const client = () => new FakeImapClient({ uidValidity: 1, uidNext: 5, messages: [{ uid: 1, source: BASIC_MESSAGE }] });
    expect(await syncMailbox(mailboxConnection.id, client)).toMatchObject({ skipped: false, discovered: 1 });

    await prisma.mailboxConnection.update({ where: { id: mailboxConnection.id }, data: { syncStatus: "syncing", syncLockedAt: new Date(Date.now() - 60 * 1000) } });
    expect(await syncMailbox(mailboxConnection.id, client)).toMatchObject({ skipped: true }); // refreshed a minute ago = still running
  });

  it("1.0: syncs abandoned at shutdown hand their mailbox back immediately", async () => {
    const { mailboxConnection } = await createTestTenantAndMailbox();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // A client whose fetch waits until we let it go — the sync is "in flight".
    const slow = () => {
      const c = new FakeImapClient({ uidValidity: 1, uidNext: 5, messages: [{ uid: 1, source: BASIC_MESSAGE }] });
      const original = c.fetchMessagesFrom.bind(c);
      c.fetchMessagesFrom = async function* (start: number) {
        await gate;
        yield* original(start);
      };
      return c;
    };
    const running = syncMailbox(mailboxConnection.id, slow);
    await new Promise((r) => setTimeout(r, 100));
    expect((await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: mailboxConnection.id } })).syncStatus).toBe("syncing");

    expect(await releaseActiveSyncLocks()).toBe(1);
    expect((await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: mailboxConnection.id } })).syncStatus).toBe("idle");
    release();
    await running;
  });
});
