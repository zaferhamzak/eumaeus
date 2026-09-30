import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { persistNormalizedEmail } from "../../src/modules/ingestion/persist.js";
import { parseImapMessage } from "../../src/modules/mail-providers/imap/parse.js";
import { purgeExpiredEmailSources } from "../../src/modules/ingestion/emailSourceRetention.js";
import { getSystemSettings, updateSystemSettings } from "../../src/modules/settings/systemSettings.js";
import { BASIC_MESSAGE, JEV_FORWARDED_MESSAGE } from "../fixtures/rawMessages.js";
import { createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("Phase 13.1 — raw email source retention", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("stores the original MIME bytes with the Email, expiring after the configured retention", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    await getSystemSettings(); // seed the settings row (default 14 days)
    const normalized = await parseImapMessage({ uid: 1, uidValidity: 1, source: BASIC_MESSAGE });

    const { email } = await persistNormalizedEmail(tenant.id, mailboxConnection.id, normalized);

    const source = await prisma.emailSource.findUniqueOrThrow({ where: { emailId: email.id } });
    expect(Buffer.from(source.source).equals(BASIC_MESSAGE)).toBe(true);
    expect(source.sizeBytes).toBe(BASIC_MESSAGE.length);
    const days = (source.expiresAt.getTime() - email.ingestedAt.getTime()) / DAY_MS;
    expect(days).toBeCloseTo(14, 5);
  });

  it("keeps no source when retention is set to 0", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    await updateSystemSettings({ rawSourceRetentionDays: 0 }, "admin@test");
    const normalized = await parseImapMessage({ uid: 2, uidValidity: 1, source: BASIC_MESSAGE });

    const { email } = await persistNormalizedEmail(tenant.id, mailboxConnection.id, normalized);

    expect(await prisma.emailSource.findUnique({ where: { emailId: email.id } })).toBeNull();
  });

  it("a duplicate persist does not create a second source row", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const normalized = await parseImapMessage({ uid: 3, uidValidity: 1, source: BASIC_MESSAGE });

    await persistNormalizedEmail(tenant.id, mailboxConnection.id, normalized);
    await persistNormalizedEmail(tenant.id, mailboxConnection.id, normalized);

    expect(await prisma.emailSource.count()).toBe(1);
  });

  it("purges only expired sources and leaves the Email row intact", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const a = await persistNormalizedEmail(tenant.id, mailboxConnection.id, await parseImapMessage({ uid: 4, uidValidity: 1, source: BASIC_MESSAGE }));
    const b = await persistNormalizedEmail(tenant.id, mailboxConnection.id, await parseImapMessage({ uid: 5, uidValidity: 1, source: BASIC_MESSAGE }));
    await prisma.emailSource.update({ where: { emailId: a.email.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const purged = await purgeExpiredEmailSources();

    expect(purged).toBe(1);
    expect(await prisma.emailSource.findUnique({ where: { emailId: a.email.id } })).toBeNull();
    expect(await prisma.emailSource.findUnique({ where: { emailId: b.email.id } })).not.toBeNull();
    expect(await prisma.email.findUnique({ where: { id: a.email.id } })).not.toBeNull();
  });

  it("marks a message carrying Eumaeus's own forwarded header", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();

    const plain = await persistNormalizedEmail(tenant.id, mailboxConnection.id, await parseImapMessage({ uid: 6, uidValidity: 1, source: BASIC_MESSAGE }));
    const forwarded = await persistNormalizedEmail(tenant.id, mailboxConnection.id, await parseImapMessage({ uid: 7, uidValidity: 1, source: JEV_FORWARDED_MESSAGE }));

    expect(plain.email.forwardedByEumaeus).toBe(false);
    expect(forwarded.email.forwardedByEumaeus).toBe(true);
  });
});
