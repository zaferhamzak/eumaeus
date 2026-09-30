import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { resetDatabase } from "../helpers/db.js";
import { buildTestServer } from "../api/helpers/buildTestServer.js";

let tenantId: string;
let mailboxConnectionId: string;
let n = 0;

async function email(fields: { from: string; to: string[]; subject: string; decision?: { status: string; destinationRef?: string } }) {
  const e = await prisma.email.create({
    data: {
      tenantId,
      mailboxConnectionId,
      provider: "imap",
      externalId: String(++n),
      uidValidity: 1,
      fromAddress: fields.from,
      toAddresses: fields.to,
      ccAddresses: [],
      bccAddresses: [],
      subject: fields.subject,
      receivedAt: new Date(Date.now() - n * 60_000),
      state: "routing",
      stateUpdatedAt: new Date(),
    },
  });
  if (fields.decision) await prisma.routingDecision.create({ data: { tenantId, emailId: e.id, status: fields.decision.status, destinationRef: fields.decision.destinationRef ?? null } });
  return e;
}

beforeEach(async () => {
  await resetDatabase();
  const tenant = await prisma.tenant.create({ data: { name: "Search Org" } });
  tenantId = tenant.id;
  const mailbox = await prisma.mailboxConnection.create({ data: { tenantId, name: "In", emailAddress: "in@example.com", provider: "imap", providerConfig: {}, status: "active" } });
  mailboxConnectionId = mailbox.id;
});

describe("GET /api/v1/emails search (Phase 28)", () => {
  it("filters by recipient (case-insensitive, any To address, % taken literally)", async () => {
    const a = await email({ from: "a@x.com", to: ["Sales@Example.com", "b@example.com"], subject: "one" });
    await email({ from: "a@x.com", to: ["support@example.com"], subject: "two" });
    await email({ from: "a@x.com", to: ["50%off@example.com"], subject: "three" });
    const app = await buildTestServer(tenantId);
    const res = await app.inject({ method: "GET", url: "/api/v1/emails?recipient=sales@" });
    expect(res.json().data.map((e: { id: string }) => e.id)).toEqual([a.id]);
    const pct = await app.inject({ method: "GET", url: "/api/v1/emails?recipient=%25" });
    expect(pct.json().data.map((e: { subject: string }) => e.subject)).toEqual(["three"]);
  });

  it("filters by where the current decision sent it", async () => {
    const finance = await email({ from: "a@x.com", to: ["i@example.com"], subject: "invoice", decision: { status: "matched", destinationRef: "Finance" } });
    const review = await email({ from: "a@x.com", to: ["i@example.com"], subject: "?", decision: { status: "unmatched" } });
    const allowed = await email({ from: "a@x.com", to: ["i@example.com"], subject: "hi", decision: { status: "sender_allowed" } });
    await email({ from: "a@x.com", to: ["i@example.com"], subject: "none" });
    const app = await buildTestServer(tenantId);
    const ids = async (destination: string) => (await app.inject({ method: "GET", url: `/api/v1/emails?destination=${destination}` })).json().data.map((e: { id: string }) => e.id);
    expect(await ids("Finance")).toEqual([finance.id]);
    expect(await ids("human_review")).toEqual([review.id]);
    expect(await ids("left_alone")).toEqual([allowed.id]);
  });

  it("combines filters", async () => {
    await email({ from: "boss@acme.com", to: ["me@example.com"], subject: "Q3 invoice", decision: { status: "matched", destinationRef: "Finance" } });
    const hit = await email({ from: "boss@acme.com", to: ["team@example.com"], subject: "Q3 invoice", decision: { status: "matched", destinationRef: "Finance" } });
    const app = await buildTestServer(tenantId);
    const res = await app.inject({ method: "GET", url: "/api/v1/emails?sender=acme&subject=invoice&recipient=team&destination=Finance" });
    expect(res.json().data.map((e: { id: string }) => e.id)).toEqual([hit.id]);
  });
});
