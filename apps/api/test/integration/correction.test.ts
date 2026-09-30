import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { correctEmail, correctionRuleDraft, CorrectionError } from "../../src/modules/corrections/correctEmail.js";
import { createRule } from "../../src/modules/rules/manageRules.js";
import { FakeArchiveClient } from "../fixtures/fakeArchiveClient.js";
import { createArchiveDestination, createMatchedRoutingDecision, createReceivedEmail, createSuccessfulAnalysis, createTestTenantAndMailbox, defaultAnswers, resetDatabase } from "../helpers/db.js";

async function movedToJunk(uid = "42", subject = "Invoice 2026-09", from = "billing@vendor.test") {
  const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
  const junk = await createArchiveDestination(tenant.id, "Junk", "INBOX.Junk");
  await createArchiveDestination(tenant.id, "Finans", "Finans");
  const email = await createReceivedEmail(tenant.id, mailboxConnection.id, uid, { fromAddress: from, subject });
  await prisma.email.update({ where: { id: email.id }, data: { messageId: `<m-${uid}@vendor.test>` } });
  const decision = await createMatchedRoutingDecision(tenant.id, email.id, "Junk");
  const move = await prisma.actionExecution.create({
    data: {
      tenantId: tenant.id, emailId: email.id, routingDecisionId: decision.id, destinationChannelId: junk.channel.id,
      channelType: "archive", channelVersion: 1, idempotencyKey: `${email.id}:${decision.id}:${junk.channel.id}`, attemptNumber: 1,
      status: "succeeded", completedAt: new Date(), responseMetadata: { moved: true, targetFolder: "INBOX.Junk", sourceFolder: "INBOX", targetUid: 500, targetUidValidity: 77 },
    },
  });
  return { tenant, mailboxConnection, email, decision, move };
}

const backFromJunk = () => {
  const client = new FakeArchiveClient({ uidValidity: 77, presentUids: [500], moveResult: { targetUid: 901, targetUidValidity: 1000 } });
  return { client, factory: () => client };
};

describe("Phase 24 — 'this belongs somewhere else'", () => {
  beforeEach(resetDatabase);

  it("moves the email back, replaces the decision, and records the person's verdict as review evidence", async () => {
    const s = await movedToJunk();
    const imap = backFromJunk();
    const result = await correctEmail(s.tenant.id, s.email.id, "Finans", "ops@acme.test", { archiveClientFactory: imap.factory });

    expect(result.undone).toBe(true);
    expect(imap.client.calls).toEqual([{ op: "move", uid: 500, target: "INBOX", folder: "INBOX.Junk" }]);
    expect(result.decision).toMatchObject({ status: "matched", destinationRef: "Finans", supersededAt: null, matchedRuleId: null });
    expect((await prisma.routingDecision.findUniqueOrThrow({ where: { id: s.decision.id } })).supersededAt).not.toBeNull();
    expect(await prisma.humanReviewItem.findFirstOrThrow({ where: { emailId: s.email.id } })).toMatchObject({ reason: "human_correction", status: "resolved", resolution: "approved" });
    expect(await prisma.auditEvent.findFirstOrThrow({ where: { eventType: "email_corrected" } })).toMatchObject({ actor: "ops@acme.test", payload: expect.objectContaining({ from: "Junk", to: "Finans", movedBack: true }) });
  });

  it("correcting INTO a junk-like destination counts as spam; 'inbox' just brings it back and runs nothing", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    await createArchiveDestination(tenant.id, "Junk", "INBOX.Junk");
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "7", { fromAddress: "x@spam.test" });
    await createMatchedRoutingDecision(tenant.id, email.id, "human_review");
    await correctEmail(tenant.id, email.id, "Junk", "ops@acme.test");
    expect(await prisma.humanReviewItem.findFirstOrThrow({ where: { emailId: email.id, reason: "human_correction" } })).toMatchObject({ resolution: "spam" });

    const s = await movedToJunk("43");
    const inbox = await correctEmail(s.tenant.id, s.email.id, "inbox", "ops@acme.test", { archiveClientFactory: backFromJunk().factory });
    expect(inbox.decision).toMatchObject({ destinationRef: "left_alone" });
  });

  it("changes nothing when the move-back fails; refuses unknown destinations and no-op corrections", async () => {
    const s = await movedToJunk();
    const gone = new FakeArchiveClient({ uidValidity: 77, presentUids: [] });
    await expect(correctEmail(s.tenant.id, s.email.id, "Finans", "ops", { archiveClientFactory: () => gone })).rejects.toMatchObject({ code: "undo_failed" });
    expect((await prisma.routingDecision.findUniqueOrThrow({ where: { id: s.decision.id } })).supersededAt).toBeNull();
    expect(await prisma.humanReviewItem.count({ where: { emailId: s.email.id } })).toBe(0);

    await expect(correctEmail(s.tenant.id, s.email.id, "Nowhere", "ops")).rejects.toBeInstanceOf(CorrectionError);
    await expect(correctEmail(s.tenant.id, s.email.id, "Junk", "ops")).rejects.toMatchObject({ code: "already_there" });
  });

  it("drafts a rule that would have prevented it: sender + the subject word shared by lookalikes, before the rule that got it wrong", async () => {
    const s = await movedToJunk("1", "Invoice 2026-09 ready");
    const t = s.tenant.id;
    const wrongRule = await createRule(t, { name: "Low spam", priority: 20, destinationRef: "Junk", conditions: { field: "answers.is_spam", op: ">=", value: 0.01 } });
    await prisma.routingDecision.update({ where: { id: s.decision.id }, data: { matchedRuleId: wrongRule.id, matchedRuleVersion: 1 } });
    for (const [uid, subject] of [["2", "Invoice 2026-08 ready"], ["3", "Invoice 2026-07 ready"], ["4", "Newsletter"]] as const) {
      const e = await createReceivedEmail(t, s.mailboxConnection.id, uid, { fromAddress: "billing@vendor.test", subject });
      await createSuccessfulAnalysis(t, e.id, defaultAnswers({ is_spam: { noul: 0.2 } }));
      await createMatchedRoutingDecision(t, e.id, "Junk");
    }
    const draft = await correctionRuleDraft(t, s.email.id, "Finans", "Junk");
    expect(draft.word).toBe("invoice");
    expect(draft.alsoWrong).toBe(2);
    expect(draft.rule).toMatchObject({
      priority: 19,
      destinationRef: "Finans",
      conditions: { op: "AND", children: [{ field: "sender.domain", op: "==", value: "vendor.test" }, { field: "subject", op: "contains", value: "invoice" }] },
    });
    expect(draft.impact.evaluated).toBeGreaterThan(0);
  });
});
