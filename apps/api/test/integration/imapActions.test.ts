import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { createArchiveExecutor } from "../../src/modules/destinations/executors/archiveExecutor.js";
import { createFlagExecutor } from "../../src/modules/destinations/executors/flagExecutor.js";
import { undoArchiveExecution, UndoRefusedError } from "../../src/modules/destinations/executors/archiveUndo.js";
import { persistNormalizedEmail } from "../../src/modules/ingestion/persist.js";
import type { ExecutionContext } from "../../src/modules/destinations/executors/types.js";
import type { NormalizedEmail } from "../../src/types/normalized-email.js";
import { FakeArchiveClient, type FakeArchiveClientOptions } from "../fixtures/fakeArchiveClient.js";
import { createArchiveDestination, createMatchedRoutingDecision, createReceivedEmail, createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";

async function setup(uidValidity = 1000, externalId = "42") {
  const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
  const email = await createReceivedEmail(tenant.id, mailboxConnection.id, externalId, { uidValidity });
  await prisma.email.update({ where: { id: email.id }, data: { messageId: "<offer-1@brand.test>" } });
  const { destination, channel } = await createArchiveDestination(tenant.id, "Spam", "Junk");
  const decision = await createMatchedRoutingDecision(tenant.id, email.id, "Spam");
  const ctx = (config: Record<string, unknown>, type = "archive"): ExecutionContext => ({
    tenantId: tenant.id,
    email: { id: email.id, mailboxConnectionId: mailboxConnection.id, externalId, uidValidity, subject: "", fromAddress: email.fromAddress, toAddresses: [] },
    routing: { destinationRef: "Spam" },
    channel: { id: channel.id, type, config, destinationId: destination.id },
    idempotencyKey: `${email.id}:${decision.id}:${channel.id}`,
  });
  return { tenant, mailboxConnection, email, destination, channel, decision, ctx };
}

function fake(options: Partial<FakeArchiveClientOptions> = {}) {
  const client = new FakeArchiveClient({ uidValidity: 1000, presentUids: [42], ...options });
  return { client, factory: () => client };
}

/** A succeeded archive execution, as the archive executor records it. */
async function archivedExecution(s: Awaited<ReturnType<typeof setup>>, metadata: Record<string, unknown>) {
  return prisma.actionExecution.create({
    data: {
      tenantId: s.tenant.id, emailId: s.email.id, routingDecisionId: s.decision.id, destinationChannelId: s.channel.id,
      channelType: "archive", channelVersion: 1, idempotencyKey: `${s.email.id}:${s.decision.id}:${s.channel.id}`, attemptNumber: 1,
      status: "succeeded", completedAt: new Date(), responseMetadata: { moved: true, targetFolder: "Junk", sourceFolder: "INBOX", ...metadata },
    },
  });
}

function normalized(uid: number, uidValidity: number, messageId?: string): NormalizedEmail {
  return { provider: "imap", externalId: String(uid), uidValidity, messageId, from: "promo@brand.test", to: ["bob@eumaeus.test"], cc: [], bcc: [], subject: "Offer", receivedAt: new Date(), hasAttachments: false, attachments: [] };
}

describe("archive with flags (Phase 15)", () => {
  beforeEach(resetDatabase);

  it("sets the flags before moving, and records where the message landed", async () => {
    const s = await setup();
    const { client, factory } = fake({ moveResult: { targetUid: 500, targetUidValidity: 77 } });

    const outcome = await createArchiveExecutor(factory).execute(s.ctx({ folder: "Junk", markSeen: true, flagged: true }));

    expect(client.calls.map((c) => c.op)).toEqual(["flags", "move"]);
    expect(client.calls[0]).toMatchObject({ flags: ["\\Seen", "\\Flagged"] });
    expect(outcome).toMatchObject({ status: "succeeded", responseMetadata: { moved: true, targetFolder: "Junk", sourceFolder: "INBOX", targetUid: 500, targetUidValidity: 77, flagsApplied: true } });
  });

  it("applies keywords as Gmail labels on Gmail, as IMAP keywords elsewhere", async () => {
    const s = await setup();
    const gmail = fake({ gmail: true });
    await createArchiveExecutor(gmail.factory).execute(s.ctx({ folder: "Junk", keywords: ["Pazarlama"] }));
    expect(gmail.client.calls[0]).toMatchObject({ flags: ["Pazarlama"], asGmailLabels: true });

    const plain = fake();
    await createArchiveExecutor(plain.factory).execute(s.ctx({ folder: "Junk", keywords: ["Pazarlama"] }));
    expect(plain.client.calls[0]).toMatchObject({ flags: ["Pazarlama"], asGmailLabels: false });
  });

  it("a flag failure happens before the move: retryable, nothing moved", async () => {
    const s = await setup();
    const { client, factory } = fake({ failOnFlags: new Error("socket closed") });
    const outcome = await createArchiveExecutor(factory).execute(s.ctx({ folder: "Junk", markSeen: true }));
    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(client.presentUids).toEqual([42]);
  });
});

describe("flag channel (Phase 15)", () => {
  beforeEach(resetDatabase);

  it("flags the message where it is, without moving it", async () => {
    const s = await setup();
    const { client, factory } = fake();
    const outcome = await createFlagExecutor(factory).execute(s.ctx({ flagged: true }, "flag"));
    expect(outcome).toMatchObject({ status: "succeeded", responseMetadata: { applied: true } });
    expect(client.calls.map((c) => c.op)).toEqual(["flags"]);
  });

  it("a message no longer in the folder: recorded as not applied, not escalated", async () => {
    const s = await setup();
    const outcome = await createFlagExecutor(fake({ presentUids: [] }).factory).execute(s.ctx({ markSeen: true }, "flag"));
    expect(outcome).toMatchObject({ status: "succeeded", responseMetadata: { applied: false, reason: "message_not_in_folder" } });
  });

  it("a changed UIDVALIDITY fails permanently", async () => {
    const s = await setup();
    const outcome = await createFlagExecutor(fake({ uidValidity: 9 }).factory).execute(s.ctx({ markSeen: true }, "flag"));
    expect(outcome).toMatchObject({ status: "failed", retryable: false });
  });
});

describe("undoing a move (Phase 15)", () => {
  beforeEach(resetDatabase);

  it("moves the message back, re-points the email, and the next sync doesn't treat it as new mail", async () => {
    const s = await setup();
    const archived = await archivedExecution(s, { targetUid: 500, targetUidValidity: 77 });
    const { client, factory } = fake({ uidValidity: 77, presentUids: [500], moveResult: { targetUid: 901, targetUidValidity: 1000 } });

    const result = await undoArchiveExecution(s.tenant.id, archived.id, "admin@test", factory);

    expect(result.status).toBe("succeeded");
    expect(client.calls).toEqual([{ op: "move", uid: 500, target: "INBOX", folder: "Junk" }]);
    expect(await prisma.email.findUniqueOrThrow({ where: { id: s.email.id } })).toMatchObject({ externalId: "901", uidValidity: 1000 });
    expect(result.execution).toMatchObject({ channelType: "archive_undo", status: "succeeded", idempotencyKey: `undo:${archived.id}` });
    expect(await prisma.auditEvent.count({ where: { eventType: "action_undone", actor: "admin@test" } })).toBe(1);

    // The sync now finds the message at its new UID.
    const persisted = await persistNormalizedEmail(s.tenant.id, s.mailboxConnection.id, normalized(901, 1000, "<offer-1@brand.test>"));
    expect(persisted).toMatchObject({ created: false, restoredAfterUndo: true });
    expect(persisted.email.id).toBe(s.email.id);
    expect(await prisma.email.count()).toBe(1);
    expect(await prisma.ingestionSuppression.count({ where: { consumedAt: null } })).toBe(0);
  });

  it("without UIDPLUS: finds the message by Message-ID and links the reappearing message the same way", async () => {
    const s = await setup();
    const archived = await archivedExecution(s, {});
    const { factory } = fake({ uidValidity: 77, presentUids: [640], messageIds: { Junk: { "<offer-1@brand.test>": 640 } } });

    expect((await undoArchiveExecution(s.tenant.id, archived.id, "admin@test", factory)).status).toBe("succeeded");

    const persisted = await persistNormalizedEmail(s.tenant.id, s.mailboxConnection.id, normalized(733, 1000, "<offer-1@brand.test>"));
    expect(persisted).toMatchObject({ created: false, restoredAfterUndo: true });
    expect(await prisma.email.findUniqueOrThrow({ where: { id: s.email.id } })).toMatchObject({ externalId: "733" });
    expect(await prisma.email.count()).toBe(1);
  });

  it("other new mail is unaffected by an open suppression", async () => {
    const s = await setup();
    const archived = await archivedExecution(s, {});
    await undoArchiveExecution(s.tenant.id, archived.id, "admin@test", fake({ uidValidity: 77, presentUids: [640], messageIds: { Junk: { "<offer-1@brand.test>": 640 } } }).factory);

    const other = await persistNormalizedEmail(s.tenant.id, s.mailboxConnection.id, normalized(734, 1000, "<different@x.test>"));
    expect(other.created).toBe(true);
  });

  it("refuses what can't be undone, and a second undo of the same move", async () => {
    const s = await setup();
    const forward = await prisma.actionExecution.create({
      data: { tenantId: s.tenant.id, emailId: s.email.id, routingDecisionId: s.decision.id, destinationChannelId: s.channel.id, channelType: "forward", channelVersion: 1, idempotencyKey: "f", attemptNumber: 1, status: "succeeded" },
    });
    await expect(undoArchiveExecution(s.tenant.id, forward.id, "a", fake().factory)).rejects.toMatchObject({ code: "not_undoable" });
    await expect(undoArchiveExecution(s.tenant.id, "missing", "a", fake().factory)).rejects.toBeInstanceOf(UndoRefusedError);

    const archived = await archivedExecution(s, { targetUid: 500, targetUidValidity: 77 });
    await undoArchiveExecution(s.tenant.id, archived.id, "a", fake({ uidValidity: 77, presentUids: [500], moveResult: {} }).factory);
    await expect(undoArchiveExecution(s.tenant.id, archived.id, "a", fake({ uidValidity: 77, presentUids: [500] }).factory)).rejects.toMatchObject({ code: "already_undone" });
  });

  it("chained moves undo newest first: an older move is refused while a later one stands, then allowed", async () => {
    const s = await setup();
    const first = await archivedExecution(s, { targetFolder: "Junk", sourceFolder: "INBOX", targetUid: 500, targetUidValidity: 77 });
    await new Promise((r) => setTimeout(r, 5));
    // The email was later moved again (Junk -> Archive) by a newer decision.
    const second = await prisma.actionExecution.create({
      data: {
        tenantId: s.tenant.id, emailId: s.email.id, routingDecisionId: s.decision.id, destinationChannelId: s.channel.id,
        channelType: "archive", channelVersion: 1, idempotencyKey: "second-move", attemptNumber: 1, status: "succeeded", completedAt: new Date(),
        responseMetadata: { moved: true, targetFolder: "Archive", sourceFolder: "Junk", targetUid: 600, targetUidValidity: 88 },
      },
    });

    const refused = undoArchiveExecution(s.tenant.id, first.id, "a", fake().factory);
    await expect(refused).rejects.toMatchObject({ code: "not_latest" });
    await expect(undoArchiveExecution(s.tenant.id, first.id, "a", fake().factory)).rejects.toThrow(/"Archive"/);
    expect(await prisma.actionExecution.count({ where: { channelType: "archive_undo" } })).toBe(0);

    // Undo the later move (Archive -> Junk), then the first (Junk -> INBOX).
    const back1 = fake({ uidValidity: 88, presentUids: [600], moveResult: { targetUid: 501, targetUidValidity: 77 } });
    expect((await undoArchiveExecution(s.tenant.id, second.id, "a", back1.factory)).status).toBe("succeeded");
    expect(back1.client.calls).toEqual([{ op: "move", uid: 600, target: "Junk", folder: "Archive" }]);
    // Back in Junk the message has a NEW uid (501, as the server reported); the
    // first move's recorded uid 500 is stale, so it's found by Message-ID.
    const back2 = fake({ uidValidity: 77, presentUids: [501], messageIds: { Junk: { "<offer-1@brand.test>": 501 } }, moveResult: { targetUid: 902, targetUidValidity: 1000 } });
    expect((await undoArchiveExecution(s.tenant.id, first.id, "a", back2.factory)).status).toBe("succeeded");
    expect(back2.client.calls).toEqual([{ op: "move", uid: 501, target: "INBOX", folder: "Junk" }]);
  });

  it("message gone from the target folder: fails with an explanation and leaves no suppression", async () => {
    const s = await setup();
    const archived = await archivedExecution(s, { targetUid: 500, targetUidValidity: 77 });
    const result = await undoArchiveExecution(s.tenant.id, archived.id, "a", fake({ uidValidity: 77, presentUids: [] }).factory);
    expect(result).toMatchObject({ status: "failed" });
    expect(result.message).toContain("no longer in");
    expect(await prisma.ingestionSuppression.count()).toBe(0);
  });

  it("connection lost after sending the move: ambiguous, suppression kept in case it landed", async () => {
    const s = await setup();
    const archived = await archivedExecution(s, { targetUid: 500, targetUidValidity: 77 });
    const result = await undoArchiveExecution(s.tenant.id, archived.id, "a", fake({ uidValidity: 77, presentUids: [500], failOnMove: new Error("reset") }).factory);
    expect(result.status).toBe("ambiguous");
    expect(await prisma.ingestionSuppression.count()).toBe(1);
  });

  it("connection failure before anything moved: failed, can be tried again", async () => {
    const s = await setup();
    const archived = await archivedExecution(s, { targetUid: 500, targetUidValidity: 77 });
    const first = await undoArchiveExecution(s.tenant.id, archived.id, "a", fake({ failOnConnect: new Error("ECONNREFUSED") }).factory);
    expect(first.status).toBe("failed");
    expect(await prisma.ingestionSuppression.count()).toBe(0);
    const second = await undoArchiveExecution(s.tenant.id, archived.id, "a", fake({ uidValidity: 77, presentUids: [500], moveResult: {} }).factory);
    expect(second.status).toBe("succeeded");
  });
});
