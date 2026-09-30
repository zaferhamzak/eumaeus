import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { syncMailbox } from "../../src/modules/mail-providers/imap/sync.js";
import { FakeImapClient } from "../fixtures/fakeImapClient.js";
import { BASIC_MESSAGE } from "../fixtures/rawMessages.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";

describe("failure — an IMAP connection failure must be explicit and must not corrupt state", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("throws, records an audit event, and leaves the sync cursor untouched", async () => {
    const { mailboxConnection } = await createTestTenantAndMailbox();

    const connectionError = new Error("ECONNREFUSED: could not reach mail.example.com:993");
    const failingClient = () => new FakeImapClient({ uidValidity: 1, uidNext: 1, messages: [], failOnConnect: connectionError });

    await expect(syncMailbox(mailboxConnection.id, failingClient)).rejects.toThrow(/ECONNREFUSED/);

    const refreshed = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: mailboxConnection.id } });
    // "No corrupted state": the cursor must be exactly what it was before the
    // failed attempt (null, since this mailbox has never synced successfully),
    // never partially advanced.
    expect(refreshed.lastUidValidity).toBeNull();
    expect(refreshed.lastSyncedUid).toBeNull();

    const failureEvents = await prisma.auditEvent.findMany({
      where: { tenantId: mailboxConnection.tenantId, eventType: "mailbox_sync_failed" },
    });
    expect(failureEvents).toHaveLength(1);
    expect((failureEvents[0]!.payload as Record<string, unknown>).errorMessage).toContain("ECONNREFUSED");

    // No emails at all — nothing was fetched before the connection failed.
    const emailCount = await prisma.email.count({ where: { mailboxConnectionId: mailboxConnection.id } });
    expect(emailCount).toBe(0);
  });

  it("a subsequent successful sync recovers fully — nothing was lost by the earlier failure", async () => {
    const { mailboxConnection } = await createTestTenantAndMailbox();

    const failingClient = () =>
      new FakeImapClient({ uidValidity: 1, uidNext: 1, messages: [], failOnConnect: new Error("temporary outage") });
    await expect(syncMailbox(mailboxConnection.id, failingClient)).rejects.toThrow();

    const workingClient = () => new FakeImapClient({ uidValidity: 1, uidNext: 20, messages: [{ uid: 1, source: BASIC_MESSAGE }] });
    const result = await syncMailbox(mailboxConnection.id, workingClient);

    expect(result.discovered).toBe(1);
    const emailCount = await prisma.email.count({ where: { mailboxConnectionId: mailboxConnection.id } });
    expect(emailCount).toBe(1);
  });
});
