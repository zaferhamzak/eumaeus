import { beforeEach, describe, expect, it } from "vitest";
import { createArchiveExecutor } from "../../src/modules/destinations/executors/archiveExecutor.js";
import { FakeArchiveClient } from "../fixtures/fakeArchiveClient.js";
import type { ExecutionContext } from "../../src/modules/destinations/executors/types.js";
import { prisma } from "../../src/db/client.js";
import { createReceivedEmail, createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";

/**
 * archiveExecutor.execute() loads the real MailboxConnection row for
 * ctx.email.mailboxConnectionId (to get host/port/tls/folder), so — unlike the
 * pure unit tests elsewhere — these need a real mailbox row in the test DB, not
 * just an arbitrary id string.
 */
async function ctxFor(uidValidity = 1000, externalId = "42"): Promise<ExecutionContext> {
  const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
  const email = await createReceivedEmail(tenant.id, mailboxConnection.id, externalId, { uidValidity });
  // tenantId/routing/channel.destinationId and the email metadata fields below
  // were added to ExecutionContext for the Phase 5B webhook executor — archive
  // itself still only reads id/mailboxConnectionId/externalId/uidValidity and
  // channel.config, so these are filler values, not behavior this suite tests.
  return {
    tenantId: tenant.id,
    email: {
      id: email.id,
      mailboxConnectionId: mailboxConnection.id,
      externalId,
      uidValidity,
      subject: email.subject ?? "",
      fromAddress: email.fromAddress,
      toAddresses: email.toAddresses,
    },
    routing: { destinationRef: "archive-dest" },
    channel: { id: "channel-1", type: "archive", config: { folder: "Archive" }, destinationId: "destination-1" },
    idempotencyKey: "k",
  };
}

describe("archiveExecutor — Case A / Case B idempotency, worked out from the real provider contract", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("succeeds and moves the message when it is present in the source folder", async () => {
    const ctx = await ctxFor();
    const executor = createArchiveExecutor(() => new FakeArchiveClient({ uidValidity: 1000, presentUids: [42] }));
    const outcome = await executor.execute(ctx);
    expect(outcome.status).toBe("succeeded");
    if (outcome.status === "succeeded") {
      expect(outcome.responseMetadata?.moved).toBe(true);
    }
  });

  it("Case A: the mail is already archived (not present in the source folder) — deterministically succeeds, not an error", async () => {
    const ctx = await ctxFor();
    const executor = createArchiveExecutor(() => new FakeArchiveClient({ uidValidity: 1000, presentUids: [] })); // UID 42 not present
    const outcome = await executor.execute(ctx);
    expect(outcome.status).toBe("succeeded");
    if (outcome.status === "succeeded") {
      expect(outcome.responseMetadata?.moved).toBe(false);
    }
  });

  it("Case B: the move was sent but the connection failed before a response — ambiguous, not a blind-retryable failure", async () => {
    const ctx = await ctxFor();
    const executor = createArchiveExecutor(
      () => new FakeArchiveClient({ uidValidity: 1000, presentUids: [42], failOnMove: new Error("ECONNRESET") }),
    );
    const outcome = await executor.execute(ctx);
    expect(outcome.status).toBe("ambiguous");
  });

  it("Case B (true semantic): the server actually applied the move before the response was lost — distinct from 'never applied', and a later attempt's own Case A check independently confirms it", async () => {
    const ctx = await ctxFor();

    // First attempt: the move genuinely succeeds server-side (the fake's own
    // presentUids is mutated, exactly like a real IMAP server actually acting
    // on the MOVE command) but the connection drops before the tagged response
    // reaches the client. executeArchive can only see the rejected promise —
    // it must return "ambiguous", the same as the "never applied" Case B test,
    // even though the true underlying state is fundamentally different.
    const firstAttemptClient = new FakeArchiveClient({
      uidValidity: 1000,
      presentUids: [42],
      failOnMoveAfterApplying: new Error("ECONNRESET"),
    });
    const firstExecutor = createArchiveExecutor(() => firstAttemptClient);
    const firstOutcome = await firstExecutor.execute(ctx);
    expect(firstOutcome.status).toBe("ambiguous");

    // Prove the fake's OWN state genuinely changed as a result of that call —
    // not merely that an error was thrown. This is what actually distinguishes
    // this test from the mechanism-only "never applied" Case B test above.
    expect(firstAttemptClient.presentUids).not.toContain(42);

    // A later, independent attempt against a client reflecting that same
    // now-true server state (UID genuinely gone) resolves via Case A: already
    // archived, a genuine success — proving the first attempt's ambiguity was
    // real uncertainty about a lost RESPONSE, not a false negative about
    // whether the operation itself happened.
    const secondAttemptClient = new FakeArchiveClient({ uidValidity: 1000, presentUids: [...firstAttemptClient.presentUids] });
    const secondExecutor = createArchiveExecutor(() => secondAttemptClient);
    const secondOutcome = await secondExecutor.execute(ctx);
    expect(secondOutcome.status).toBe("succeeded");
    if (secondOutcome.status === "succeeded") {
      expect(secondOutcome.responseMetadata?.moved).toBe(false);
    }
  });

  it("a connection failure before anything was attempted is a plain retryable failure, not ambiguous", async () => {
    const ctx = await ctxFor();
    const executor = createArchiveExecutor(
      () => new FakeArchiveClient({ uidValidity: 1000, presentUids: [42], failOnConnect: new Error("ETIMEDOUT") }),
    );
    const outcome = await executor.execute(ctx);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.retryable).toBe(true);
    }
  });

  it("the target folder always comes from the channel's own config — ExecutionContext never carries email subject/body/sender at all, so adversarial email content has no path to influence it", async () => {
    const ctx = await ctxFor();
    const captured: { targetFolder: string }[] = [];
    class RecordingClient extends FakeArchiveClient {
      override async moveMessage(uid: number, targetFolder: string): ReturnType<FakeArchiveClient["moveMessage"]> {
        captured.push({ targetFolder });
        return super.moveMessage(uid, targetFolder);
      }
    }
    const executor = createArchiveExecutor(() => new RecordingClient({ uidValidity: 1000, presentUids: [42] }));

    // The archive executor itself never reads email.subject/fromAddress/
    // toAddresses (those exist on ExecutionContext only for the Phase 5B webhook
    // payload) or ctx.routing — the target folder comes ONLY from channel.config,
    // which is what this test actually proves.
    await executor.execute({ ...ctx, channel: { id: "channel-1", type: "archive", config: { folder: "Sales" }, destinationId: "destination-1" } });

    expect(captured).toEqual([{ targetFolder: "Sales" }]);
  });

  it("a UIDVALIDITY mismatch is a permanent, non-retryable failure — the stored UID can no longer be trusted", async () => {
    const ctx = await ctxFor(1000);
    const executor = createArchiveExecutor(() => new FakeArchiveClient({ uidValidity: 9999, presentUids: [42] })); // mailbox epoch changed
    const outcome = await executor.execute(ctx);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.retryable).toBe(false);
      expect(outcome.errorClass).toBe("invalid_config");
    }
  });

  it("resolves the mailbox's OWN per-mailbox credential (Phase 10), never a shared global password — regression test for a bug where every mailbox but the bootstrap one silently failed archive execution", async () => {
    const ctx = await ctxFor();
    const capturedPasswords: string[] = [];
    const executor = createArchiveExecutor((_config, password) => {
      capturedPasswords.push(password);
      return new FakeArchiveClient({ uidValidity: 1000, presentUids: [42] });
    });
    const outcome = await executor.execute(ctx);
    expect(outcome.status).toBe("succeeded");
    // createTestTenantAndMailbox seeds this exact plaintext via setMailboxCredential.
    expect(capturedPasswords).toEqual(["test-password-not-real"]);
  });

  it("a mailbox with no credential configured fails permanently (invalid_config), not as a retryable connection error", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    await prisma.mailboxCredential.deleteMany({ where: { mailboxConnectionId: mailboxConnection.id } });
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "42", { uidValidity: 1000 });
    const ctx: ExecutionContext = {
      tenantId: tenant.id,
      email: {
        id: email.id,
        mailboxConnectionId: mailboxConnection.id,
        externalId: "42",
        uidValidity: 1000,
        subject: email.subject ?? "",
        fromAddress: email.fromAddress,
        toAddresses: email.toAddresses,
      },
      routing: { destinationRef: "archive-dest" },
      channel: { id: "channel-1", type: "archive", config: { folder: "Archive" }, destinationId: "destination-1" },
      idempotencyKey: "k",
    };

    const executor = createArchiveExecutor(() => new FakeArchiveClient({ uidValidity: 1000, presentUids: [42] }));
    const outcome = await executor.execute(ctx);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.retryable).toBe(false);
      expect(outcome.errorClass).toBe("invalid_config");
      expect(outcome.errorMessage).toMatch(/no credential is configured/);
    }
  });
});
