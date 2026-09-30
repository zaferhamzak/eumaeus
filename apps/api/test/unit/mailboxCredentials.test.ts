import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase, createTestTenantAndMailbox } from "../helpers/db.js";
import { setMailboxCredential, resolveMailboxPassword, MailboxCredentialError } from "../../src/modules/mail-providers/imap/mailboxCredentials.js";
import { prisma } from "../../src/db/client.js";

describe("mailboxCredentials — per-mailbox encrypted password storage", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("round-trips: set then resolve returns the exact original plaintext", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    await setMailboxCredential(tenant.id, mailboxConnection.id, "correct-horse-battery-staple");
    const resolved = await resolveMailboxPassword(tenant.id, mailboxConnection.id);
    expect(resolved).toBe("correct-horse-battery-staple");
  });

  it("is stored encrypted (the packed v1.<iv>.<tag>.<ciphertext> format), never plaintext", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    await setMailboxCredential(tenant.id, mailboxConnection.id, "a-very-recognizable-password");
    const row = await prisma.mailboxCredential.findUniqueOrThrow({ where: { mailboxConnectionId: mailboxConnection.id } });
    expect(row.encryptedValue).not.toContain("a-very-recognizable-password");
    expect(row.encryptedValue.split(".")).toHaveLength(4);
    expect(row.encryptedValue.startsWith("v1.")).toBe(true);
  });

  it("setting a credential twice REPLACES it (upsert), never creates a second row", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    await setMailboxCredential(tenant.id, mailboxConnection.id, "first-password");
    await setMailboxCredential(tenant.id, mailboxConnection.id, "second-password");

    const rows = await prisma.mailboxCredential.findMany({ where: { mailboxConnectionId: mailboxConnection.id } });
    expect(rows).toHaveLength(1);
    expect(await resolveMailboxPassword(tenant.id, mailboxConnection.id)).toBe("second-password");
  });

  it("mailbox A and mailbox B store completely independent credentials — resolving one never returns the other's", async () => {
    const { tenant: tenantA, mailboxConnection: mailboxA } = await createTestTenantAndMailbox();
    const { tenant: tenantB, mailboxConnection: mailboxB } = await createTestTenantAndMailbox();
    await setMailboxCredential(tenantA.id, mailboxA.id, "password-for-a");
    await setMailboxCredential(tenantB.id, mailboxB.id, "password-for-b");

    expect(await resolveMailboxPassword(tenantA.id, mailboxA.id)).toBe("password-for-a");
    expect(await resolveMailboxPassword(tenantB.id, mailboxB.id)).toBe("password-for-b");
  });

  it("resolving a credential that was never set fails loudly rather than silently returning something", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    await prisma.mailboxCredential.deleteMany({ where: { mailboxConnectionId: mailboxConnection.id } });
    await expect(resolveMailboxPassword(tenant.id, mailboxConnection.id)).rejects.toThrow(MailboxCredentialError);
  });

  it("resolving a credential scoped to the WRONG tenant fails — cannot read another tenant's mailbox credential by id alone", async () => {
    const { mailboxConnection: mailboxA } = await createTestTenantAndMailbox();
    const { tenant: tenantB } = await createTestTenantAndMailbox();
    await expect(resolveMailboxPassword(tenantB.id, mailboxA.id)).rejects.toThrow(MailboxCredentialError);
  });

  it("rejects an empty password", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    await expect(setMailboxCredential(tenant.id, mailboxConnection.id, "")).rejects.toThrow(MailboxCredentialError);
  });
});
