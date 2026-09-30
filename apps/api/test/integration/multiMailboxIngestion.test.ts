import { beforeEach, describe, expect, it } from "vitest";
import { syncMailbox } from "../../src/modules/mail-providers/imap/sync.js";
import { createMailboxConnection } from "../../src/modules/mail-providers/imap/manageMailboxConnections.js";
import { FakeImapClient } from "../fixtures/fakeImapClient.js";
import { BASIC_MESSAGE } from "../fixtures/rawMessages.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";
import { prisma } from "../../src/db/client.js";

/**
 * Phase 10's "EMAIL INGESTION" requirement: multiple mailboxes must be
 * independently pollable, each using ITS OWN configuration and credential —
 * never accidentally another mailbox's. Proven here by capturing exactly
 * what host/username/password syncMailbox() actually hands to the IMAP
 * client for each of two distinct mailboxes.
 */
describe("multi-mailbox ingestion — each mailbox syncs with its OWN configuration and credential", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("mailbox A processes using mailbox A's config/credential; mailbox B independently uses mailbox B's", async () => {
    const { tenant } = await createTestTenantAndMailbox();

    const mailboxA = await createMailboxConnection(tenant.id, {
      name: "A",
      emailAddress: "a@example.com",
      host: "imap-a.example.com",
      port: 993,
      tls: true,
      folder: "INBOX",
      username: "a@example.com",
      password: "password-for-a",
    });
    const mailboxB = await createMailboxConnection(tenant.id, {
      name: "B",
      emailAddress: "b@example.com",
      host: "imap-b.example.com",
      port: 993,
      tls: true,
      folder: "INBOX",
      username: "b@example.com",
      password: "password-for-b",
    });

    const seenA: Array<{ host: string; username: string; password: string }> = [];
    const seenB: Array<{ host: string; username: string; password: string }> = [];

    await syncMailbox(mailboxA.id, (config, password) => {
      seenA.push({ host: config.host, username: config.username, password });
      return new FakeImapClient({ uidValidity: 1, uidNext: 100, messages: [{ uid: 1, source: BASIC_MESSAGE }] });
    });
    await syncMailbox(mailboxB.id, (config, password) => {
      seenB.push({ host: config.host, username: config.username, password });
      return new FakeImapClient({ uidValidity: 1, uidNext: 100, messages: [] });
    });

    expect(seenA).toEqual([{ host: "imap-a.example.com", username: "a@example.com", password: "password-for-a" }]);
    expect(seenB).toEqual([{ host: "imap-b.example.com", username: "b@example.com", password: "password-for-b" }]);

    // Emails discovered via mailbox A must be attributed to mailbox A, never B.
    const emails = await prisma.email.findMany({ where: { tenantId: tenant.id } });
    expect(emails).toHaveLength(1);
    expect(emails[0]!.mailboxConnectionId).toBe(mailboxA.id);
  });

  it("a mailbox created through the API is immediately independently pollable — no shared/global credential leaks into it", async () => {
    const { tenant, mailboxConnection: legacy } = await createTestTenantAndMailbox();
    const created = await createMailboxConnection(tenant.id, {
      name: "New",
      emailAddress: "new@example.com",
      host: "imap-new.example.com",
      port: 993,
      tls: true,
      folder: "INBOX",
      username: "new@example.com",
      password: "brand-new-password",
    });

    let capturedForLegacy = "";
    let capturedForNew = "";
    await syncMailbox(legacy.id, (_config, password) => {
      capturedForLegacy = password;
      return new FakeImapClient({ uidValidity: 1, uidNext: 1, messages: [] });
    });
    await syncMailbox(created.id, (_config, password) => {
      capturedForNew = password;
      return new FakeImapClient({ uidValidity: 1, uidNext: 1, messages: [] });
    });

    expect(capturedForLegacy).toBe("test-password-not-real"); // set by createTestTenantAndMailbox
    expect(capturedForNew).toBe("brand-new-password");
    expect(capturedForLegacy).not.toBe(capturedForNew);
  });

  it("syncing a mailbox with no stored credential fails loudly and releases the sync lock (does not hang in 'syncing' forever)", async () => {
    const { mailboxConnection } = await createTestTenantAndMailbox();
    await prisma.mailboxCredential.deleteMany({ where: { mailboxConnectionId: mailboxConnection.id } });

    await expect(
      syncMailbox(mailboxConnection.id, () => new FakeImapClient({ uidValidity: 1, uidNext: 1, messages: [] })),
    ).rejects.toThrow(/no credential is configured/);

    const row = await prisma.mailboxConnection.findUniqueOrThrow({ where: { id: mailboxConnection.id } });
    expect(row.syncStatus).toBe("failed");
    expect(row.syncLockedAt).toBeNull();
    expect(row.lastSyncError).toMatch(/no credential is configured/);
  });
});
