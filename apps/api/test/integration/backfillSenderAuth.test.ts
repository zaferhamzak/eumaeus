import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { resetDatabase } from "../helpers/db.js";
import { backfillSenderAuth } from "../../src/modules/ingestion/backfillSenderAuth.js";

describe("backfillSenderAuth", () => {
  beforeEach(resetDatabase);

  it("fills in older mail from its stored source, once, and leaves mail without a source unknown", async () => {
    const tenant = await prisma.tenant.create({ data: { name: "Org" } });
    const mailbox = await prisma.mailboxConnection.create({ data: { tenantId: tenant.id, name: "In", emailAddress: "in@x.test", provider: "imap", providerConfig: {}, status: "active" } });
    const make = (id: string) =>
      prisma.email.create({ data: { tenantId: tenant.id, mailboxConnectionId: mailbox.id, provider: "imap", externalId: id, uidValidity: 1, fromAddress: "a@bank.com", toAddresses: [], ccAddresses: [], bccAddresses: [], subject: "x", receivedAt: new Date(), state: "routing", stateUpdatedAt: new Date() } });
    const withSource = await make("1");
    const noVerdict = await make("2");
    const noSource = await make("3");
    const source = (text: string) => Buffer.from(text);
    await prisma.emailSource.create({ data: { emailId: withSource.id, tenantId: tenant.id, source: source("Authentication-Results: mx.p.net; spf=fail smtp.mailfrom=a@bank.com; dmarc=fail header.from=bank.com\r\nFrom: a@bank.com\r\n\r\nhi"), sizeBytes: 10, expiresAt: new Date(Date.now() + 86400_000) } });
    await prisma.emailSource.create({ data: { emailId: noVerdict.id, tenantId: tenant.id, source: source("From: a@bank.com\r\n\r\nhi"), sizeBytes: 10, expiresAt: new Date(Date.now() + 86400_000) } });

    expect(await backfillSenderAuth()).toEqual({ filled: 2, withVerdict: 1 });
    const rows = new Map((await prisma.email.findMany()).map((e) => [e.id, e]));
    expect(rows.get(withSource.id)).toMatchObject({ senderAuthCaptured: true, senderAuth: expect.objectContaining({ spf: "fail", dmarc: "fail", authenticated: false }) });
    expect(rows.get(noVerdict.id)).toMatchObject({ senderAuthCaptured: true, senderAuth: null });
    expect(rows.get(noSource.id)).toMatchObject({ senderAuthCaptured: false });
    expect(await backfillSenderAuth()).toEqual({ filled: 0, withVerdict: 0 });
  });
});
