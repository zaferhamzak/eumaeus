import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { evaluateRulesForEmail } from "../../src/modules/rules/evaluateRulesForEmail.js";
import { createRule } from "../../src/modules/rules/manageRules.js";
import { createRuleGraph } from "../../src/modules/rule-graphs/manageRuleGraphs.js";
import { simulateRouting, SimulationValidationError, DRAFT_ID } from "../../src/modules/rules/simulateRouting.js";
import { ruleMatchStats } from "../../src/modules/rules/ruleStats.js";
import type { ConditionNode } from "../../src/modules/rules/conditions.js";
import { createReceivedEmail, createSuccessfulAnalysis, createTestTenantAndMailbox, defaultAnswers, resetDatabase } from "../helpers/db.js";

const SPAM: ConditionNode = { field: "answers.is_spam", op: ">=", value: 0.8 };
const MARKETING: ConditionNode = { field: "answers.category", op: "==", value: "marketing" };

/** Three analyzed emails: spam, marketing, business. */
async function fixture() {
  const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
  const specs = [
    { id: "1", subject: "You won", answers: defaultAnswers({ is_spam: { noul: 0.95 }, category: { choice: "marketing", probabilities: {}, confidence: 0.9 } }) },
    { id: "2", subject: "Autumn sale", answers: defaultAnswers({ category: { choice: "marketing", probabilities: {}, confidence: 0.9 } }) },
    { id: "3", subject: "Partnership", answers: defaultAnswers() },
  ];
  const emails = [];
  for (const spec of specs) {
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, spec.id, { subject: spec.subject });
    await createSuccessfulAnalysis(tenant.id, email.id, spec.answers);
    emails.push(email);
  }
  return { tenant, mailboxConnection, emails };
}

async function tableCounts() {
  const [decisions, evaluations, audits, reviews, executions] = await Promise.all([
    prisma.routingDecision.count(),
    prisma.ruleEvaluation.count(),
    prisma.auditEvent.count(),
    prisma.humanReviewItem.count(),
    prisma.actionExecution.count(),
  ]);
  return { decisions, evaluations, audits, reviews, executions };
}

describe("simulateRouting (Phase 14)", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("parity: re-simulating the live rule set reproduces exactly what the live engine decided", async () => {
    const { tenant, emails } = await fixture();
    const spamRule = await createRule(tenant.id, { name: "Spam", priority: 10, conditions: SPAM, destinationRef: "spam-folder" });
    await createRule(tenant.id, { name: "Marketing", priority: 20, conditions: MARKETING, destinationRef: "marketing" });
    for (const email of emails) await evaluateRulesForEmail(email.id);

    // Replace the spam rule with an identical draft: nothing may change.
    const result = await simulateRouting(tenant.id, { type: "rule", replaceRuleId: spamRule.id, rule: { name: "Spam", priority: 10, conditions: SPAM, destinationRef: "spam-folder" } });

    expect(result.evaluated).toBe(3);
    expect(result.changed).toBe(0);
    expect(result.byDestination).toEqual(
      expect.arrayContaining([
        { destinationRef: "spam-folder", count: 1 },
        { destinationRef: "marketing", count: 1 },
        { destinationRef: "human_review", count: 1 },
      ]),
    );
  });

  it("parity for graphs: a graph assigned live and the same graph simulated agree", async () => {
    const { tenant, mailboxConnection, emails } = await fixture();
    const graphInput = {
      name: "Triage",
      rootNodeKey: "spam",
      nodes: [
        { key: "spam", conditions: SPAM, onTrue: { type: "action" as const, destinationRef: "spam-folder" }, onFalse: { type: "node" as const, nodeKey: "mkt" } },
        { key: "mkt", conditions: MARKETING, onTrue: { type: "action" as const, destinationRef: "marketing" }, onFalse: { type: "action" as const, destinationRef: "human_review" } },
      ],
    };
    const graph = await createRuleGraph(tenant.id, graphInput);
    await prisma.mailboxConnection.update({ where: { id: mailboxConnection.id }, data: { ruleGraphId: graph.graph.id } });
    for (const email of emails) await evaluateRulesForEmail(email.id);

    const result = await simulateRouting(tenant.id, { type: "graph", graph: graphInput });

    expect(result.changed).toBe(0);
    expect(result.draftMatched).toBe(3);
  });

  it("a new rule: reports what it would take over, with changed emails first in the samples", async () => {
    const { tenant, emails } = await fixture();
    await createRule(tenant.id, { name: "Spam", priority: 10, conditions: SPAM, destinationRef: "spam-folder" });
    for (const email of emails) await evaluateRulesForEmail(email.id);

    const result = await simulateRouting(tenant.id, { type: "rule", rule: { name: "Marketing", priority: 20, conditions: MARKETING, destinationRef: "marketing" } });

    expect(result.draftMatched).toBe(1); // the spam email is still taken by the higher-priority spam rule
    expect(result.changed).toBe(1);
    expect(result.samples[0]).toMatchObject({ changed: true, before: { destinationRef: "human_review" }, after: { destinationRef: "marketing", ruleId: DRAFT_ID, ruleName: "Marketing" } });
  });

  it("writes nothing at all", async () => {
    const { tenant } = await fixture();
    await createRule(tenant.id, { name: "Spam", priority: 10, conditions: SPAM, destinationRef: "spam-folder" });
    const before = await tableCounts();

    await simulateRouting(tenant.id, { type: "rule", rule: { name: "Marketing", priority: 20, conditions: MARKETING, destinationRef: "marketing" } });
    await simulateRouting(tenant.id, { type: "graph", graph: { name: "g", rootNodeKey: "a", nodes: [{ key: "a", conditions: SPAM, onTrue: { type: "action", destinationRef: "x" }, onFalse: { type: "action", destinationRef: "y" } }] } });

    expect(await tableCounts()).toEqual(before);
  });

  it("respects live precedence: a mailbox's assigned graph decides, not the draft rule; forced review stays forced", async () => {
    const { tenant, mailboxConnection, emails } = await fixture();
    const graph = await createRuleGraph(tenant.id, { name: "g", rootNodeKey: "a", nodes: [{ key: "a", conditions: SPAM, onTrue: { type: "action", destinationRef: "x" }, onFalse: { type: "action", destinationRef: "y" } }] });
    await prisma.mailboxConnection.update({ where: { id: mailboxConnection.id }, data: { ruleGraphId: graph.graph.id } });
    await prisma.analysisResult.updateMany({ where: { emailId: emails[2]!.id }, data: { answers: defaultAnswers({ human_review_required: { noul: 0.9 } }) as never as object } });

    const result = await simulateRouting(tenant.id, { type: "rule", rule: { name: "All", priority: 1, conditions: { field: "subject", op: "contains", value: "" }, destinationRef: "everything" } });

    expect(result.draftMatched).toBe(0);
    expect(result.decidedByAssignedGraph).toBe(2);
    expect(result.forcedToReview).toBe(1);
  });

  it("counts emails without analysis and honours the scope", async () => {
    const { tenant, mailboxConnection } = await fixture();
    const old = await createReceivedEmail(tenant.id, mailboxConnection.id, "9");
    await prisma.email.update({ where: { id: old.id }, data: { receivedAt: new Date("2020-01-01T00:00:00Z") } });

    const all = await simulateRouting(tenant.id, { type: "rule", rule: { name: "r", priority: 5, conditions: SPAM, destinationRef: "x" } });
    expect(all.evaluated).toBe(4);
    expect(all.withoutAnalysis).toBe(1);

    const recent = await simulateRouting(tenant.id, { type: "rule", rule: { name: "r", priority: 5, conditions: SPAM, destinationRef: "x" } }, { since: new Date("2021-01-01T00:00:00Z"), limit: 2 });
    expect(recent.evaluated).toBe(2);
    expect(recent.truncated).toBe(true);
  });

  it("rejects what saving would reject: invalid conditions, a taken priority, an unknown rule to replace", async () => {
    const { tenant } = await fixture();
    await createRule(tenant.id, { name: "Spam", priority: 10, conditions: SPAM, destinationRef: "spam-folder" });
    const attempt = (target: Parameters<typeof simulateRouting>[1]) => simulateRouting(tenant.id, target);

    await expect(attempt({ type: "rule", rule: { name: "x", priority: 10, conditions: MARKETING, destinationRef: "m" } })).rejects.toThrow(/priority 10 is already used/);
    await expect(attempt({ type: "rule", rule: { name: "x", priority: 11, conditions: { field: "nope", op: "==", value: 1 }, destinationRef: "m" } })).rejects.toBeInstanceOf(SimulationValidationError);
    await expect(attempt({ type: "rule", replaceRuleId: "missing", rule: { name: "x", priority: 12, conditions: MARKETING, destinationRef: "m" } })).rejects.toThrow(/not an active rule/);
  });

  it("1000 emails simulate in under 5 seconds", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const now = new Date();
    await prisma.email.createMany({
      data: Array.from({ length: 1000 }, (_, i) => ({
        tenantId: tenant.id, mailboxConnectionId: mailboxConnection.id, provider: "imap", externalId: String(i + 1), uidValidity: 1,
        fromAddress: `s${i}@x.test`, toAddresses: ["bob@eumaeus.test"], ccAddresses: [], bccAddresses: [], subject: `m${i}`,
        receivedAt: now, hasAttachments: false, state: "received", stateUpdatedAt: now,
      })),
    });
    const ids = await prisma.email.findMany({ select: { id: true } });
    await prisma.analysisResult.createMany({ data: ids.map(({ id }) => ({ tenantId: tenant.id, emailId: id, schemaVersion: "v1", jevModel: "jev", answers: defaultAnswers() as never as object, status: "ok", inputTokens: 1, outputTokens: 0 })) });
    for (let p = 1; p <= 20; p += 1) await createRule(tenant.id, { name: `r${p}`, priority: p, conditions: { field: "subject", op: "contains", value: `zz${p}` }, destinationRef: "d" });

    const started = Date.now();
    const result = await simulateRouting(tenant.id, { type: "rule", rule: { name: "draft", priority: 99, conditions: SPAM, destinationRef: "x" } }, { limit: 1000 });
    expect(result.evaluated).toBe(1000);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("ruleMatchStats", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("counts matches over 7 and 30 days and the last match", async () => {
    const { tenant, emails } = await fixture();
    const rule = await createRule(tenant.id, { name: "Marketing", priority: 20, conditions: MARKETING, destinationRef: "marketing" });
    for (const email of emails) await evaluateRulesForEmail(email.id);
    await prisma.ruleEvaluation.updateMany({ where: { emailId: emails[0]!.id }, data: { evaluatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) } });

    const stats = (await ruleMatchStats([rule.id])).get(rule.id)!;

    expect(stats).toMatchObject({ matchesLast30Days: 2, matchesLast7Days: 1, evaluationsLast30Days: 3 });
    expect(stats.lastMatchedAt).not.toBeNull();
  });
});
