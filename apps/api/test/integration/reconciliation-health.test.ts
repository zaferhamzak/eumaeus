import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { syncMailbox } from "../../src/modules/mail-providers/imap/sync.js";
import { FakeImapClient } from "../fixtures/fakeImapClient.js";
import { BASIC_MESSAGE } from "../fixtures/rawMessages.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";

describe("reconciliation health state — 'if an email appears to be missing, can we tell whether sync is running?'", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("a failed sync sets syncStatus=failed with an error, and leaves the cursor untouched", async () => {
    const { mailboxConnection } = await createTestTenantAndMailbox();
    const failingClient = () =>
      new FakeImapClient({ uidValidity: 1, uidNext: 1, messages: [], failOnConnect: new Error("IMAP unreachable") });

    await expect(syncMailbox(mailboxConnection.id, failingClient)).rejects.toThrow();

    const refreshed = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: mailboxConnection.id } });
    expect(refreshed.syncStatus).toBe("failed");
    expect(refreshed.syncLockedAt).toBeNull(); // lock released even on failure, not left stuck as "syncing"
    expect(refreshed.lastSyncError).toContain("IMAP unreachable");
    expect(refreshed.lastSyncFailureAt).not.toBeNull();
    expect(refreshed.lastSyncAttemptAt).not.toBeNull();
    expect(refreshed.lastSyncSuccessAt).toBeNull();
    // Cursor correctness must remain intact.
    expect(refreshed.lastUidValidity).toBeNull();
    expect(refreshed.lastSyncedUid).toBeNull();
  });

  it("recovery: a later successful sync clears the failed status and records success", async () => {
    const { mailboxConnection } = await createTestTenantAndMailbox();
    const failingClient = () =>
      new FakeImapClient({ uidValidity: 1, uidNext: 1, messages: [], failOnConnect: new Error("temporary outage") });
    await expect(syncMailbox(mailboxConnection.id, failingClient)).rejects.toThrow();
    await expect(syncMailbox(mailboxConnection.id, failingClient)).rejects.toThrow();

    const afterFailure = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: mailboxConnection.id } });
    expect(afterFailure.syncStatus).toBe("failed");
    expect(afterFailure.consecutiveSyncFailures).toBe(2); // failures in a row

    const workingClient = () => new FakeImapClient({ uidValidity: 1, uidNext: 5, messages: [{ uid: 1, source: BASIC_MESSAGE }] });
    const result = await syncMailbox(mailboxConnection.id, workingClient);
    expect(result.skipped).toBe(false);

    const afterRecovery = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: mailboxConnection.id } });
    expect(afterRecovery.syncStatus).toBe("idle");
    expect(afterRecovery.lastSyncSuccessAt).not.toBeNull();
    expect(afterRecovery.consecutiveSyncFailures).toBe(0); // a success ends the streak
    // The failure record is kept for history (this phase never claimed it would be
    // erased — only syncStatus reflects the CURRENT state), while success fields
    // now reflect the recovered run.
    expect(afterRecovery.lastSyncError).toContain("temporary outage");
  });

  it("a sync that finds no new mail is still a successful sync, not a no-op that skips health tracking", async () => {
    const { mailboxConnection } = await createTestTenantAndMailbox();
    // uidNext=1 with no messages at all — nothing new to discover.
    const emptyClient = () => new FakeImapClient({ uidValidity: 1, uidNext: 1, messages: [] });

    const before = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: mailboxConnection.id } });
    expect(before.lastSyncSuccessAt).toBeNull();

    const result = await syncMailbox(mailboxConnection.id, emptyClient);
    expect(result.skipped).toBe(false);
    expect(result.discovered).toBe(0);
    expect(result.alreadyKnown).toBe(0);

    const after = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: mailboxConnection.id } });
    // "No new email" must not be confused with "no synchronization" — the health
    // fields prove a real sync attempt happened and succeeded.
    expect(after.syncStatus).toBe("idle");
    expect(after.lastSyncSuccessAt).not.toBeNull();
    expect(after.lastSyncAttemptAt).not.toBeNull();
    expect(after.lastUidValidity).toBe(1);

    const completedEvents = await prisma.auditEvent.findMany({
      where: { tenantId: mailboxConnection.tenantId, eventType: "mailbox_sync_completed" },
    });
    expect(completedEvents).toHaveLength(1);
  });
});

describe("a password the server keeps rejecting", () => {
  beforeEach(resetDatabase);

  const rejected = () => {
    const error = Object.assign(new Error("Command failed"), { authenticationFailed: true, responseText: "Application-specific password required", serverResponseCode: "ALERT" });
    return new FakeImapClient({ uidValidity: 1, uidNext: 1, messages: [], failOnConnect: error });
  };

  it("records what the server said, stops after 3 rejections in a row, and resumes when a new password is saved", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    await expect(syncMailbox(mailboxConnection.id, rejected)).rejects.toThrow();
    const first = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: mailboxConnection.id } });
    expect(first.lastSyncError).toBe("Command failed (while connecting / signing in; sign-in rejected; [ALERT]; server said: Application-specific password required)");
    expect(first.status).toBe("active"); // one rejection can be a glitch

    await expect(syncMailbox(mailboxConnection.id, rejected)).rejects.toThrow();
    await expect(syncMailbox(mailboxConnection.id, rejected)).rejects.toThrow();
    const stopped = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: mailboxConnection.id } });
    expect(stopped.status).toBe("reauth_required");
    expect(stopped.lastSyncError).toContain("update the password");
    expect(await syncMailbox(mailboxConnection.id, rejected)).toMatchObject({ skipped: true, skipReason: "mailbox_disabled" });

    const { updateMailboxConnection } = await import("../../src/modules/mail-providers/imap/manageMailboxConnections.js");
    await updateMailboxConnection(tenant.id, mailboxConnection.id, { password: "new-app-password" });
    expect((await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: mailboxConnection.id } })).status).toBe("active");
    const working = () => new FakeImapClient({ uidValidity: 1, uidNext: 5, messages: [{ uid: 1, source: BASIC_MESSAGE }] });
    expect(await syncMailbox(mailboxConnection.id, working)).toMatchObject({ skipped: false, discovered: 1 });
  });

  it("other failures (network) never stop the mailbox", async () => {
    const { mailboxConnection } = await createTestTenantAndMailbox();
    const down = () => new FakeImapClient({ uidValidity: 1, uidNext: 1, messages: [], failOnConnect: new Error("ETIMEDOUT") });
    for (let i = 0; i < 4; i++) await expect(syncMailbox(mailboxConnection.id, down)).rejects.toThrow();
    expect((await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: mailboxConnection.id } })).status).toBe("active");
  });
});
