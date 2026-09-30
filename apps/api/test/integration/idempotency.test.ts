import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { syncMailbox } from "../../src/modules/mail-providers/imap/sync.js";
import { persistNormalizedEmail } from "../../src/modules/ingestion/persist.js";
import { parseImapMessage } from "../../src/modules/mail-providers/imap/parse.js";
import { FakeImapClient } from "../fixtures/fakeImapClient.js";
import { BASIC_MESSAGE, WITH_ATTACHMENT } from "../fixtures/rawMessages.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";

describe("idempotency — the same IMAP message must never produce two Email rows", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("running sync twice in a row does not duplicate emails (incremental cursor skips the already-synced range)", async () => {
    const { mailboxConnection } = await createTestTenantAndMailbox();

    const fakeClient = () =>
      new FakeImapClient({
        uidValidity: 1000,
        uidNext: 200,
        messages: [
          { uid: 10, source: BASIC_MESSAGE },
          { uid: 11, source: WITH_ATTACHMENT },
        ],
      });

    const first = await syncMailbox(mailboxConnection.id, fakeClient);
    expect(first.discovered).toBe(2);
    expect(first.alreadyKnown).toBe(0);

    // A second run against an unchanged mailbox correctly fetches nothing new —
    // the cursor (lastSyncedUid) already moved past these UIDs, so there is no
    // wasted re-fetch. Zero-and-zero here is the efficient-path guarantee; the
    // dedup-under-overlap guarantee is exercised separately below.
    const second = await syncMailbox(mailboxConnection.id, fakeClient);
    expect(second.discovered).toBe(0);
    expect(second.alreadyKnown).toBe(0);

    const emails = await prisma.email.findMany({ where: { mailboxConnectionId: mailboxConnection.id } });
    expect(emails).toHaveLength(2);
  });

  it("re-scanning a UID range that overlaps already-persisted messages does not duplicate them", async () => {
    // Simulates what a future reconciliation pass or a UIDVALIDITY-triggered reset
    // does: re-fetching a range that includes UIDs already in the database. This is
    // where `alreadyKnown` is actually expected to be non-zero, and where the
    // "even if a reconciliation scan re-fetches everything, no duplicates" part of
    // the guarantee is proven.
    const { mailboxConnection } = await createTestTenantAndMailbox();

    const fakeClient = () =>
      new FakeImapClient({
        uidValidity: 1000,
        uidNext: 200,
        messages: [
          { uid: 10, source: BASIC_MESSAGE },
          { uid: 11, source: WITH_ATTACHMENT },
        ],
      });

    await syncMailbox(mailboxConnection.id, fakeClient);

    // Force a re-scan of the same range, as a reconciliation pass would.
    await prisma.mailboxConnection.update({ where: { id: mailboxConnection.id }, data: { lastSyncedUid: 0 } });

    const rescan = await syncMailbox(mailboxConnection.id, fakeClient);
    expect(rescan.discovered).toBe(0);
    expect(rescan.alreadyKnown).toBe(2);

    const emails = await prisma.email.findMany({ where: { mailboxConnectionId: mailboxConnection.id } });
    expect(emails).toHaveLength(2);
  });

  it("calling persistNormalizedEmail twice for the same message is a no-op the second time", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const normalized = await parseImapMessage({ uid: 42, uidValidity: 1, source: BASIC_MESSAGE });

    const firstResult = await persistNormalizedEmail(tenant.id, mailboxConnection.id, normalized);
    const secondResult = await persistNormalizedEmail(tenant.id, mailboxConnection.id, normalized);

    expect(firstResult.created).toBe(true);
    expect(secondResult.created).toBe(false);
    expect(secondResult.email.id).toBe(firstResult.email.id);

    const count = await prisma.email.count({ where: { mailboxConnectionId: mailboxConnection.id } });
    expect(count).toBe(1);

    // Exactly one EMAIL_DISCOVERED audit event, not two — a retried/duplicate
    // discovery must not duplicate the audit trail either.
    const discoveredEvents = await prisma.auditEvent.findMany({
      where: { emailId: firstResult.email.id, eventType: "email_discovered" },
    });
    expect(discoveredEvents).toHaveLength(1);
  });

  it("the database itself rejects a duplicate identity, independent of application logic", async () => {
    // This proves the guarantee does not rest solely on the application's
    // check-then-insert logic (implementation-plan.md §G: "Do not rely only on
    // application-level checks") — a raw second insert with the same identity must
    // fail at the database layer.
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const now = new Date();

    const data = {
      tenantId: tenant.id,
      mailboxConnectionId: mailboxConnection.id,
      provider: "imap",
      externalId: "999",
      uidValidity: 1,
      fromAddress: "a@b.com",
      toAddresses: [],
      ccAddresses: [],
      bccAddresses: [],
      receivedAt: now,
      hasAttachments: false,
      state: "received",
      stateUpdatedAt: now,
    };

    await prisma.email.create({ data });
    await expect(prisma.email.create({ data })).rejects.toMatchObject({ code: "P2002" });
  });
});
