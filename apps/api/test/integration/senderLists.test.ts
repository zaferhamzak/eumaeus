import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { evaluateRulesForEmail } from "../../src/modules/rules/evaluateRulesForEmail.js";
import { createRule } from "../../src/modules/rules/manageRules.js";
import { addSenderEntry, SenderListError } from "../../src/modules/rules/manageSenderList.js";
import { simulateRouting, LEFT_ALONE } from "../../src/modules/rules/simulateRouting.js";
import { acceptSuggestion, dismissSuggestion, refreshSuggestions } from "../../src/modules/review/suggestions.js";
import { createReceivedEmail, createSuccessfulAnalysis, createTestTenantAndMailbox, defaultAnswers, resetDatabase } from "../helpers/db.js";

let uid = 0;
async function email(tenantId: string, mailboxId: string, from: string, analyzed = true) {
  const e = await createReceivedEmail(tenantId, mailboxId, String(++uid), { fromAddress: from });
  if (analyzed) await createSuccessfulAnalysis(tenantId, e.id, defaultAnswers());
  return e;
}

describe("allow / block lists in the live engine (Phase 16)", () => {
  beforeEach(resetDatabase);

  it("an allowed (VIP) sender is left alone: no rule, no action, no Human Review — even without an analysis", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    await createRule(tenant.id, { name: "All", priority: 1, conditions: { field: "subject", op: "contains", value: "" }, destinationRef: "everything" });
    await addSenderEntry(tenant.id, { kind: "allow", pattern: "ceo@acme.com" }, "admin");
    const analyzed = await email(tenant.id, mailboxConnection.id, "CEO@acme.com");
    const unanalyzed = await email(tenant.id, mailboxConnection.id, "ceo@acme.com", false);

    for (const e of [analyzed, unanalyzed]) await evaluateRulesForEmail(e.id);

    const decisions = await prisma.routingDecision.findMany();
    expect(decisions.map((d) => d.status)).toEqual(["sender_allowed", "sender_allowed"]);
    expect(decisions[0]).toMatchObject({ senderListPattern: "ceo@acme.com", destinationRef: null });
    expect(await prisma.humanReviewItem.count()).toBe(0);
    expect(await prisma.ruleEvaluation.count()).toBe(0);
  });

  it("a blocked sender goes to the organization's block destination, or to Human Review when none is set", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    await addSenderEntry(tenant.id, { kind: "block", pattern: "@spam.test" }, "admin");
    const first = await email(tenant.id, mailboxConnection.id, "a@mail.spam.test");
    await evaluateRulesForEmail(first.id);
    expect(await prisma.routingDecision.findFirstOrThrow({ where: { emailId: first.id, supersededAt: null } })).toMatchObject({ status: "matched", destinationRef: "human_review", senderListPattern: "@spam.test" });

    await prisma.tenant.update({ where: { id: tenant.id }, data: { blockDestinationRef: "Spam klasoru" } });
    const second = await email(tenant.id, mailboxConnection.id, "b@spam.test");
    await evaluateRulesForEmail(second.id);
    expect(await prisma.routingDecision.findFirstOrThrow({ where: { emailId: second.id, supersededAt: null } })).toMatchObject({ status: "matched", destinationRef: "Spam klasoru" });
  });

  it("a pattern can only be on the list once", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    await addSenderEntry(tenant.id, { kind: "allow", pattern: "acme.com" }, "admin");
    await expect(addSenderEntry(tenant.id, { kind: "block", pattern: "@ACME.com" }, "admin")).rejects.toBeInstanceOf(SenderListError);
    await expect(addSenderEntry(tenant.id, { kind: "block", pattern: "not a sender" }, "admin")).rejects.toBeInstanceOf(SenderListError);
  });

  it("simulation: lists are part of parity, and a draft entry shows what it would catch", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const rule = await createRule(tenant.id, { name: "All", priority: 1, conditions: { field: "subject", op: "contains", value: "" }, destinationRef: "everything" });
    await addSenderEntry(tenant.id, { kind: "allow", pattern: "ceo@acme.com" }, "admin");
    const emails = [await email(tenant.id, mailboxConnection.id, "ceo@acme.com"), await email(tenant.id, mailboxConnection.id, "x@promo.test"), await email(tenant.id, mailboxConnection.id, "y@promo.test")];
    for (const e of emails) await evaluateRulesForEmail(e.id);

    const parity = await simulateRouting(tenant.id, { type: "rule", replaceRuleId: rule.id, rule: { name: "All", priority: 1, conditions: { field: "subject", op: "contains", value: "" }, destinationRef: "everything" } });
    expect(parity.changed).toBe(0);
    expect(parity.byDestination).toContainEqual({ destinationRef: LEFT_ALONE, count: 1 });

    const draft = await simulateRouting(tenant.id, { type: "sender_entry", entry: { kind: "block", pattern: "promo.test" } });
    expect(draft).toMatchObject({ draftMatched: 2, changed: 2 });
  });
});

describe("suggestions from Human Review (Phase 16)", () => {
  beforeEach(resetDatabase);

  async function resolved(tenantId: string, mailboxId: string, from: string, resolution: "spam" | "approved", times: number) {
    for (let i = 0; i < times; i += 1) {
      const e = await email(tenantId, mailboxId, from, false);
      await prisma.humanReviewItem.create({ data: { tenantId, emailId: e.id, reason: "unmatched", status: "resolved", resolution, resolvedAt: new Date() } });
    }
  }

  it("5 of 5 marked spam from one address -> block that address; 4 is not enough; a mixed record suggests nothing", async () => {
    const { tenant, mailboxConnection: m } = await createTestTenantAndMailbox();
    await resolved(tenant.id, m.id, "promo@shop.test", "spam", 5);
    await resolved(tenant.id, m.id, "almost@x.test", "spam", 4);
    await resolved(tenant.id, m.id, "mixed@y.test", "spam", 3);
    await resolved(tenant.id, m.id, "mixed@y.test", "approved", 3);

    const open = await refreshSuggestions(tenant.id);

    expect(open.map((s) => [s.kind, s.pattern, s.spamCount, s.resolvedCount])).toEqual([["block", "promo@shop.test", 5, 5]]);
  });

  it("two addresses of one company agreeing -> the domain; never a public mail provider's domain", async () => {
    const { tenant, mailboxConnection: m } = await createTestTenantAndMailbox();
    await resolved(tenant.id, m.id, "anna@partner.test", "approved", 3);
    await resolved(tenant.id, m.id, "ben@partner.test", "approved", 3);
    await resolved(tenant.id, m.id, "a@gmail.com", "spam", 3);
    await resolved(tenant.id, m.id, "b@gmail.com", "spam", 3);

    const patterns = (await refreshSuggestions(tenant.id)).map((s) => `${s.kind}:${s.pattern}`).sort();

    expect(patterns).toEqual(["allow:@partner.test"]);
  });

  it("accepting puts the sender on the list; dismissing keeps it quiet for 90 days; a listed sender isn't suggested", async () => {
    const { tenant, mailboxConnection: m } = await createTestTenantAndMailbox();
    await resolved(tenant.id, m.id, "promo@shop.test", "spam", 5);
    await resolved(tenant.id, m.id, "news@letter.test", "spam", 5);
    const [a, b] = await refreshSuggestions(tenant.id);

    await acceptSuggestion(tenant.id, a!.id, "admin");
    expect(await prisma.senderListEntry.findFirstOrThrow({ where: { pattern: a!.pattern } })).toMatchObject({ kind: "block", source: "suggestion" });
    await dismissSuggestion(tenant.id, b!.id, "admin");

    expect(await refreshSuggestions(tenant.id)).toEqual([]);
    const later = new Date(Date.now() + 91 * 24 * 60 * 60 * 1000);
    await prisma.humanReviewItem.updateMany({ data: { resolvedAt: new Date(later.getTime() - 60_000) } });
    expect((await refreshSuggestions(tenant.id, later)).map((s) => s.pattern)).toEqual([b!.pattern]);
  });

  it("a suggestion whose evidence no longer holds is withdrawn", async () => {
    const { tenant, mailboxConnection: m } = await createTestTenantAndMailbox();
    await resolved(tenant.id, m.id, "promo@shop.test", "spam", 5);
    expect(await refreshSuggestions(tenant.id)).toHaveLength(1);
    await resolved(tenant.id, m.id, "promo@shop.test", "approved", 3);
    expect(await refreshSuggestions(tenant.id)).toHaveLength(0);
  });
});
