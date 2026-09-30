import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { resetDatabase } from "../helpers/db.js";
import { buildTestServer } from "../api/helpers/buildTestServer.js";
import { buildServer } from "../../src/api/server.js";

function asUser(id: string, email: string) {
  return buildServer({ logger: false, authResolver: async () => ({ id, email, isSuperAdmin: false }) });
}

let tenantId: string;
let itemId: string;
let reviewerId: string;
let readerId: string;

beforeEach(async () => {
  await resetDatabase();
  const tenant = await prisma.tenant.create({ data: { name: "Team Org" } });
  tenantId = tenant.id;
  const mailbox = await prisma.mailboxConnection.create({ data: { tenantId, name: "In", emailAddress: "in@example.com", provider: "imap", providerConfig: {}, status: "active" } });
  const email = await prisma.email.create({
    data: { tenantId, mailboxConnectionId: mailbox.id, provider: "imap", externalId: "1", uidValidity: 1, fromAddress: "a@x.com", toAddresses: [], ccAddresses: [], bccAddresses: [], subject: "?", receivedAt: new Date(), state: "awaiting_review", stateUpdatedAt: new Date() },
  });
  itemId = (await prisma.humanReviewItem.create({ data: { tenantId, emailId: email.id, reason: "unmatched" } })).id;
  const reviewer = await prisma.user.create({ data: { email: "rev@example.com", passwordHash: "x" } });
  const reader = await prisma.user.create({ data: { email: "read@example.com", passwordHash: "x" } });
  reviewerId = reviewer.id;
  readerId = reader.id;
  await prisma.membership.create({ data: { userId: reviewer.id, tenantId, permissions: ["reviews:read", "reviews:resolve"], status: "active" } });
  await prisma.membership.create({ data: { userId: reader.id, tenantId, permissions: ["reviews:read"], status: "active" } });
});

describe("Human Review teamwork (Phase 28)", () => {
  it("lists only members who can decide as assignees", async () => {
    const app = await buildTestServer(tenantId);
    const res = await app.inject({ method: "GET", url: "/api/v1/reviews/assignees" });
    expect(res.json().data).toEqual([{ userId: reviewerId, email: "rev@example.com" }]);
  });

  it("assigns, filters by assignee, unassigns — and audits each change", async () => {
    const app = await buildTestServer(tenantId);
    const assign = await app.inject({ method: "POST", url: `/api/v1/reviews/${itemId}/assign`, payload: { userId: reviewerId } });
    expect(assign.statusCode).toBe(200);
    expect(assign.json().assignedTo).toBe(reviewerId);

    const mine = await app.inject({ method: "GET", url: `/api/v1/reviews?assignedTo=${reviewerId}` });
    expect(mine.json().data.map((i: { id: string; assignedToEmail: string }) => [i.id, i.assignedToEmail])).toEqual([[itemId, "rev@example.com"]]);
    expect((await app.inject({ method: "GET", url: "/api/v1/reviews?assignedTo=none" })).json().data).toHaveLength(0);

    const refused = await app.inject({ method: "POST", url: `/api/v1/reviews/${itemId}/assign`, payload: { userId: readerId } });
    expect(refused.statusCode).toBe(400);

    await app.inject({ method: "POST", url: `/api/v1/reviews/${itemId}/assign`, payload: { userId: null } });
    expect((await app.inject({ method: "GET", url: "/api/v1/reviews?assignedTo=none" })).json().data).toHaveLength(1);

    const events = await prisma.auditEvent.findMany({ where: { tenantId, eventType: "review_assigned" }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => (e.payload as { assignedToEmail: string | null }).assignedToEmail)).toEqual(["rev@example.com", null]);
  });

  it("'me' is the person asking", async () => {
    await prisma.humanReviewItem.update({ where: { id: itemId }, data: { assignedTo: reviewerId } });
    const headers = { "x-organization-id": tenantId };
    const mine = await asUser(reviewerId, "rev@example.com").inject({ method: "GET", url: "/api/v1/reviews?assignedTo=me", headers });
    expect(mine.json().data.map((i: { id: string }) => i.id)).toEqual([itemId]);
    const theirs = await asUser(readerId, "read@example.com").inject({ method: "GET", url: "/api/v1/reviews?assignedTo=me", headers });
    expect(theirs.statusCode).toBe(200);
    expect(theirs.json().data).toHaveLength(0);
  });

  it("adds notes to the audit log and shows them on the item", async () => {
    const app = await buildTestServer(tenantId);
    const add = await app.inject({ method: "POST", url: `/api/v1/reviews/${itemId}/notes`, payload: { text: "  Asked finance, waiting.  " } });
    expect(add.statusCode).toBe(201);
    expect(add.json().text).toBe("Asked finance, waiting.");
    await app.inject({ method: "POST", url: `/api/v1/reviews/${itemId}/notes`, payload: { text: "They confirmed." } });
    expect((await app.inject({ method: "POST", url: `/api/v1/reviews/${itemId}/notes`, payload: { text: "   " } })).statusCode).toBe(400);

    const detail = await app.inject({ method: "GET", url: `/api/v1/reviews/${itemId}` });
    expect(detail.json().notes.map((n: { text: string }) => n.text)).toEqual(["Asked finance, waiting.", "They confirmed."]);
    expect(await prisma.auditEvent.count({ where: { tenantId, eventType: "review_note_added" } })).toBe(2);
  });

  it("needs reviews:resolve to assign or add notes", async () => {
    const app = asUser(readerId, "read@example.com");
    const headers = { "x-organization-id": tenantId };
    expect((await app.inject({ method: "POST", url: `/api/v1/reviews/${itemId}/assign`, payload: { userId: reviewerId }, headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/v1/reviews/${itemId}/notes`, payload: { text: "x" }, headers })).statusCode).toBe(403);
  });
});
