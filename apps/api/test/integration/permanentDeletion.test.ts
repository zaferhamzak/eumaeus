import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { resetDatabase } from "../helpers/db.js";
import { buildServer } from "../../src/api/server.js";
import { syncMailbox } from "../../src/modules/mail-providers/imap/sync.js";

let tenantId: string;
let otherTenantId: string;
let mailboxId: string;
let adminId: string;
let n = 0;

const admin = () => buildServer({ logger: false, authResolver: async () => ({ id: adminId, email: "root@jev.test", isSuperAdmin: true }) });
const member = (userId: string) => buildServer({ logger: false, authResolver: async () => ({ id: userId, email: "m@jev.test", isSuperAdmin: false }) });

async function email(tenant: string, mailbox: string) {
  const e = await prisma.email.create({
    data: { tenantId: tenant, mailboxConnectionId: mailbox, provider: "imap", externalId: String(++n), uidValidity: 1, fromAddress: "a@x.com", toAddresses: [], ccAddresses: [], bccAddresses: [], subject: "s", receivedAt: new Date(), state: "awaiting_review", stateUpdatedAt: new Date() },
  });
  await prisma.humanReviewItem.create({ data: { tenantId: tenant, emailId: e.id, reason: "unmatched" } });
  await prisma.routingDecision.create({ data: { tenantId: tenant, emailId: e.id, status: "unmatched" } });
  await prisma.auditEvent.create({ data: { tenantId: tenant, emailId: e.id, eventType: "email_ingested", actor: "system", payload: {} } });
  return e;
}

beforeEach(async () => {
  await resetDatabase();
  adminId = (await prisma.user.create({ data: { email: "root@jev.test", passwordHash: "x", isSuperAdmin: true } })).id;
  tenantId = (await prisma.tenant.create({ data: { name: "Deneme Org" } })).id;
  otherTenantId = (await prisma.tenant.create({ data: { name: "Other" } })).id;
  mailboxId = (await prisma.mailboxConnection.create({ data: { tenantId, name: "In", emailAddress: "in@deneme.test", provider: "imap", providerConfig: {}, status: "active" } })).id;
  await prisma.rule.create({ data: { tenantId, name: "R", priority: 1, conditions: { field: "subject", op: "contains", value: "x" }, destinationRef: "human_review" } });
});

describe("organization: deactivate, reactivate, delete permanently", () => {
  it("a deactivated organization's mailboxes stop syncing", async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { status: "disabled" } });
    expect(await syncMailbox(mailboxId)).toMatchObject({ skipped: true, skipReason: "organization_disabled" });
  });

  it("must be deactivated first and the name typed; then everything it owns is gone and the deletion is recorded", async () => {
    const otherMailbox = await prisma.mailboxConnection.create({ data: { tenantId: otherTenantId, name: "O", emailAddress: "o@other.test", provider: "imap", providerConfig: {}, status: "active" } });
    await email(tenantId, mailboxId);
    await email(otherTenantId, otherMailbox.id);
    // 1.2 (F): its delivery log goes too — not left behind as orphaned "system" rows.
    await prisma.outboundEmail.createMany({ data: [{ tenantId, kind: "alert", toAddress: "a@x.test", subject: "t", status: "sent" }, { tenantId: otherTenantId, kind: "alert", toAddress: "b@x.test", subject: "t", status: "sent" }] });
    const headers = { "x-organization-id": otherTenantId };
    const app = admin();

    const active = await app.inject({ method: "POST", url: `/api/v1/organizations/${tenantId}/delete-permanently`, headers, payload: { confirmName: "Deneme Org" } });
    expect(active.statusCode).toBe(409);

    await app.inject({ method: "DELETE", url: `/api/v1/organizations/${tenantId}`, headers });
    const wrongName = await app.inject({ method: "POST", url: `/api/v1/organizations/${tenantId}/delete-permanently`, headers, payload: { confirmName: "Deneme" } });
    expect(wrongName.statusCode).toBe(400);

    const done = await app.inject({ method: "POST", url: `/api/v1/organizations/${tenantId}/delete-permanently`, headers, payload: { confirmName: " deneme org " } });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ name: "Deneme Org", mailboxes: 1, emails: 1 });

    expect(await prisma.tenant.findUnique({ where: { id: tenantId } })).toBeNull();
    for (const count of [prisma.email.count({ where: { tenantId } }), prisma.rule.count({ where: { tenantId } }), prisma.auditEvent.count({ where: { tenantId } }), prisma.mailboxConnection.count({ where: { tenantId } })]) expect(await count).toBe(0);
    // The other organization is untouched.
    expect(await prisma.email.count({ where: { tenantId: otherTenantId } })).toBe(1);
    expect((await prisma.outboundEmail.findMany()).map((r) => r.tenantId)).toEqual([otherTenantId]);
    expect(await prisma.authEvent.findFirst({ where: { eventType: "organization_deleted" } })).toMatchObject({ userId: adminId, payload: expect.objectContaining({ name: "Deneme Org", emails: 1 }) });
  });

  it("reactivating brings it back; deleting permanently is for the system administrator only", async () => {
    const user = await prisma.user.create({ data: { email: "m@jev.test", passwordHash: "x" } });
    await prisma.membership.create({ data: { userId: user.id, tenantId, permissions: ["organizations:read", "organizations:delete"], status: "active" } });
    const headers = { "x-organization-id": tenantId };
    await prisma.tenant.update({ where: { id: tenantId }, data: { status: "disabled" } });
    expect((await member(user.id).inject({ method: "POST", url: `/api/v1/organizations/${tenantId}/delete-permanently`, headers, payload: { confirmName: "Deneme Org" } })).statusCode).toBe(403);
    const back = await member(user.id).inject({ method: "POST", url: `/api/v1/organizations/${tenantId}/reactivate`, headers });
    expect(back.statusCode).toBe(200);
    expect(back.json().status).toBe("active");
  });
});

describe("mailbox: delete permanently", () => {
  it("must be disabled and its address typed; deletes it with its emails only", async () => {
    const keep = await prisma.mailboxConnection.create({ data: { tenantId, name: "Keep", emailAddress: "keep@deneme.test", provider: "imap", providerConfig: {}, status: "active" } });
    await email(tenantId, mailboxId);
    await email(tenantId, mailboxId);
    await email(tenantId, keep.id);
    const headers = { "x-organization-id": tenantId };
    const app = admin();
    expect((await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/delete-permanently`, headers, payload: { confirmAddress: "in@deneme.test" } })).statusCode).toBe(409);
    await prisma.mailboxConnection.update({ where: { id: mailboxId }, data: { status: "disabled" } });
    expect((await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/delete-permanently`, headers, payload: { confirmAddress: "other@x" } })).statusCode).toBe(400);
    const done = await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/delete-permanently`, headers, payload: { confirmAddress: "IN@deneme.test" } });
    expect(done.json()).toEqual({ emailAddress: "in@deneme.test", emails: 2 });
    expect(await prisma.mailboxConnection.findUnique({ where: { id: mailboxId } })).toBeNull();
    expect(await prisma.email.count({ where: { tenantId } })).toBe(1);
    expect(await prisma.auditEvent.findFirst({ where: { tenantId, eventType: "mailbox_deleted" } })).toMatchObject({ actor: "root@jev.test" });
  });
});

describe("emails: delete selected", () => {
  it("deletes only this organization's selected emails, needs privacy:erase, and audits", async () => {
    const a = await email(tenantId, mailboxId);
    const b = await email(tenantId, mailboxId);
    const otherMailbox = await prisma.mailboxConnection.create({ data: { tenantId: otherTenantId, name: "O", emailAddress: "o@other.test", provider: "imap", providerConfig: {}, status: "active" } });
    const foreign = await email(otherTenantId, otherMailbox.id);
    const headers = { "x-organization-id": tenantId };

    const user = await prisma.user.create({ data: { email: "m@jev.test", passwordHash: "x" } });
    await prisma.membership.create({ data: { userId: user.id, tenantId, permissions: ["emails:read"], status: "active" } });
    expect((await member(user.id).inject({ method: "POST", url: "/api/v1/emails/delete", headers, payload: { emailIds: [a.id] } })).statusCode).toBe(403);

    const res = await admin().inject({ method: "POST", url: "/api/v1/emails/delete", headers, payload: { emailIds: [a.id, foreign.id] } });
    expect(res.json()).toEqual({ deleted: 1 });
    expect(await prisma.email.findUnique({ where: { id: a.id } })).toBeNull();
    expect(await prisma.email.findUnique({ where: { id: b.id } })).not.toBeNull();
    expect(await prisma.email.findUnique({ where: { id: foreign.id } })).not.toBeNull();
    expect(await prisma.auditEvent.findFirst({ where: { tenantId, eventType: "emails_deleted" } })).toMatchObject({ payload: { count: 1, emailIds: [a.id] } });
  });
});
