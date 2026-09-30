import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { evaluateRulesForEmail } from "../../src/modules/rules/evaluateRulesForEmail.js";
import { createRule, updateRule, RuleValidationError } from "../../src/modules/rules/manageRules.js";
import { createRuleGraph, updateRuleGraph } from "../../src/modules/rule-graphs/manageRuleGraphs.js";
import { EmailState } from "../../src/types/email-state.js";
import {
  createReceivedEmail,
  createSuccessfulAnalysis,
  createTestTenantAndMailbox,
  defaultAnswers,
  resetDatabase,
} from "../helpers/db.js";

describe("Rule Engine — AnalysisResult -> Rule Engine -> RoutingDecision", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  describe("basic matching", () => {
    it("routes to the destination of the one matching rule", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
      await createSuccessfulAnalysis(tenant.id, email.id, defaultAnswers());

      await createRule(tenant.id, {
        name: "Business opportunities",
        priority: 10,
        destinationRef: "sales",
        conditions: { field: "answers.is_business_opportunity", op: "==", value: true },
      });

      await evaluateRulesForEmail(email.id);

      const decision = await prisma.routingDecision.findFirstOrThrow({ where: { emailId: email.id, supersededAt: null } });
      expect(decision).toMatchObject({ status: "matched", destinationRef: "sales" });

      const refreshedEmail = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
      expect(refreshedEmail.state).toBe(EmailState.ROUTING);
    });

    it("escalates to Human Review when no rule matches", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "2");
      await createSuccessfulAnalysis(tenant.id, email.id, defaultAnswers());

      await createRule(tenant.id, {
        name: "Spam only",
        priority: 10,
        destinationRef: "archive",
        conditions: { field: "answers.is_spam", op: "==", value: true }, // false in defaultAnswers()
      });

      await evaluateRulesForEmail(email.id);

      const decision = await prisma.routingDecision.findFirstOrThrow({ where: { emailId: email.id, supersededAt: null } });
      expect(decision.status).toBe("unmatched");

      const refreshedEmail = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
      expect(refreshedEmail.state).toBe(EmailState.AWAITING_REVIEW);

      const reviewItems = await prisma.humanReviewItem.findMany({ where: { emailId: email.id } });
      expect(reviewItems).toMatchObject([{ reason: "unmatched", status: "open" }]);
    });

    it("ignores a disabled rule entirely (no RuleEvaluation row, does not win)", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "3");
      await createSuccessfulAnalysis(tenant.id, email.id, defaultAnswers());

      const disabled = await createRule(tenant.id, {
        name: "Would match but disabled",
        priority: 10,
        destinationRef: "sales",
        conditions: { field: "answers.is_business_opportunity", op: "==", value: true },
      });
      await prisma.rule.update({ where: { id: disabled.id }, data: { enabled: false } });

      await evaluateRulesForEmail(email.id);

      const decision = await prisma.routingDecision.findFirstOrThrow({ where: { emailId: email.id, supersededAt: null } });
      expect(decision.status).toBe("unmatched");
      const evaluations = await prisma.ruleEvaluation.findMany({ where: { emailId: email.id } });
      expect(evaluations).toHaveLength(0);
    });
  });

  describe("multiple rules — deterministic priority/conflict resolution", () => {
    it("the lowest-priority-number matching rule wins, even when a later rule would also match", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "4");
      await createSuccessfulAnalysis(tenant.id, email.id, defaultAnswers());

      await createRule(tenant.id, {
        name: "Broad opportunity rule",
        priority: 20,
        destinationRef: "sales-broad",
        conditions: { field: "answers.is_business_opportunity", op: "==", value: true },
      });
      await createRule(tenant.id, {
        name: "Specific high-priority rule",
        priority: 5,
        destinationRef: "sales-priority",
        conditions: { field: "answers.is_business_opportunity", op: "==", value: true },
      });

      await evaluateRulesForEmail(email.id);

      const decision = await prisma.routingDecision.findFirstOrThrow({ where: { emailId: email.id, supersededAt: null } });
      expect(decision.destinationRef).toBe("sales-priority");

      // Both rules were actually evaluated up to and including the winner —
      // evaluation order stops at the FIRST match, per priority ascending.
      const evaluations = await prisma.ruleEvaluation.findMany({
        where: { emailId: email.id },
        orderBy: { evaluatedAt: "asc" },
      });
      expect(evaluations).toHaveLength(1); // only priority 5 was evaluated; priority 20 never reached
      expect(evaluations[0]?.matched).toBe(true);
    });

    it("running the same evaluation repeatedly (same AnalysisResult, same rules) always produces the same decision", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "5");
      await createSuccessfulAnalysis(tenant.id, email.id, defaultAnswers());
      await createRule(tenant.id, {
        name: "Rule A",
        priority: 10,
        destinationRef: "sales",
        conditions: { field: "answers.is_business_opportunity", op: "==", value: true },
      });

      await evaluateRulesForEmail(email.id);
      const first = await prisma.routingDecision.findFirstOrThrow({ where: { emailId: email.id, supersededAt: null } });
      await evaluateRulesForEmail(email.id); // idempotent no-op, see idempotency section below
      const second = await prisma.routingDecision.findFirstOrThrow({ where: { emailId: email.id, supersededAt: null } });

      expect(second).toEqual(first);
    });
  });

  describe("human_review_required signal", () => {
    it("forces escalation even when a rule would otherwise match — never silently routed as safe", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "6");
      await createSuccessfulAnalysis(
        tenant.id,
        email.id,
        defaultAnswers({ human_review_required: { noul: 0.9 } }),
      );

      await createRule(tenant.id, {
        name: "Would match",
        priority: 10,
        destinationRef: "sales",
        conditions: { field: "answers.is_business_opportunity", op: "==", value: true },
      });

      await evaluateRulesForEmail(email.id);

      const decision = await prisma.routingDecision.findFirstOrThrow({ where: { emailId: email.id, supersededAt: null } });
      expect(decision.status).toBe("human_review_forced");
      expect(decision.destinationRef).toBeNull();

      const refreshedEmail = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
      expect(refreshedEmail.state).toBe(EmailState.AWAITING_REVIEW);

      // No rule was even evaluated — the override short-circuits before that.
      const evaluations = await prisma.ruleEvaluation.findMany({ where: { emailId: email.id } });
      expect(evaluations).toHaveLength(0);
    });

    it("Phase 12: a raised per-organization threshold lets a below-threshold signal fall through to the rules", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      await prisma.tenant.update({ where: { id: tenant.id }, data: { humanReviewSignalThreshold: 0.95 } });
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "6b");
      await createSuccessfulAnalysis(tenant.id, email.id, defaultAnswers({ human_review_required: { noul: 0.9 } }));
      await createRule(tenant.id, {
        name: "Would match",
        priority: 10,
        destinationRef: "sales",
        conditions: { field: "answers.is_business_opportunity", op: "==", value: true },
      });

      await evaluateRulesForEmail(email.id);

      const decision = await prisma.routingDecision.findFirstOrThrow({ where: { emailId: email.id, supersededAt: null } });
      expect(decision).toMatchObject({ status: "matched", destinationRef: "sales" });
    });

    it("Phase 12: disabling the signal for an organization means rules alone decide, even at noul 1.0", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      await prisma.tenant.update({ where: { id: tenant.id }, data: { humanReviewSignalEnabled: false } });
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "6c");
      await createSuccessfulAnalysis(tenant.id, email.id, defaultAnswers({ human_review_required: { noul: 1 } }));
      await createRule(tenant.id, {
        name: "Would match",
        priority: 10,
        destinationRef: "sales",
        conditions: { field: "answers.is_business_opportunity", op: "==", value: true },
      });

      await evaluateRulesForEmail(email.id);

      const decision = await prisma.routingDecision.findFirstOrThrow({ where: { emailId: email.id, supersededAt: null } });
      expect(decision.status).toBe("matched");
    });
  });

  describe("missing AnalysisResult", () => {
    it("escalates to Human Review rather than guessing", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "7");
      // No AnalysisResult created at all.

      await evaluateRulesForEmail(email.id);

      const decision = await prisma.routingDecision.findFirstOrThrow({ where: { emailId: email.id, supersededAt: null } });
      expect(decision.status).toBe("missing_analysis");
      expect(decision.analysisResultId).toBeNull();

      const refreshedEmail = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
      expect(refreshedEmail.state).toBe(EmailState.AWAITING_REVIEW);
    });
  });

  describe("idempotency", () => {
    it("processing the same analyzed email twice does not create a second or contradictory RoutingDecision", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "8");
      await createSuccessfulAnalysis(tenant.id, email.id, defaultAnswers());
      await createRule(tenant.id, {
        name: "Rule A",
        priority: 10,
        destinationRef: "sales",
        conditions: { field: "answers.is_business_opportunity", op: "==", value: true },
      });

      await evaluateRulesForEmail(email.id);
      await evaluateRulesForEmail(email.id);
      await evaluateRulesForEmail(email.id);

      const decisions = await prisma.routingDecision.findMany({ where: { emailId: email.id } });
      expect(decisions).toHaveLength(1);
      const evaluations = await prisma.ruleEvaluation.findMany({ where: { emailId: email.id } });
      expect(evaluations).toHaveLength(1); // not re-evaluated on the second/third call
    });
  });

  describe("rule versioning", () => {
    it("updateRule deactivates the old version and creates a new one, and past evaluations keep pointing at the version live at the time", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "9");
      await createSuccessfulAnalysis(tenant.id, email.id, defaultAnswers());

      const v1 = await createRule(tenant.id, {
        name: "Opportunity rule",
        priority: 10,
        destinationRef: "sales-v1",
        conditions: { field: "answers.is_business_opportunity", op: "==", value: true },
      });
      await evaluateRulesForEmail(email.id);

      const decisionV1 = await prisma.routingDecision.findFirstOrThrow({ where: { emailId: email.id, supersededAt: null } });
      expect(decisionV1.matchedRuleVersion).toBe(1);

      const v2 = await updateRule(v1.id, {
        name: "Opportunity rule",
        priority: 10,
        destinationRef: "sales-v2",
        conditions: { field: "answers.is_business_opportunity", op: "==", value: true },
      });
      expect(v2.version).toBe(2);
      expect(v2.id).not.toBe(v1.id);

      const oldRow = await prisma.rule.findUniqueOrThrow({ where: { id: v1.id } });
      expect(oldRow.enabled).toBe(false);
      expect(oldRow.deactivatedAt).not.toBeNull();

      // The evaluation already recorded still references version 1 — history
      // doesn't retroactively change because the rule was edited afterward.
      const evaluation = await prisma.ruleEvaluation.findFirstOrThrow({ where: { emailId: email.id } });
      expect(evaluation.ruleVersion).toBe(1);
    });

    it("rejects a duplicate active priority within a tenant", async () => {
      const { tenant } = await createTestTenantAndMailbox();
      await createRule(tenant.id, {
        name: "First",
        priority: 10,
        destinationRef: "a",
        conditions: { field: "answers.is_spam", op: "==", value: true },
      });

      await expect(
        createRule(tenant.id, {
          name: "Second",
          priority: 10,
          destinationRef: "b",
          conditions: { field: "answers.is_spam", op: "==", value: true },
        }),
      ).rejects.toBeInstanceOf(RuleValidationError);
    });

    it("rejects an invalid rule at creation time", async () => {
      const { tenant } = await createTestTenantAndMailbox();
      await expect(
        createRule(tenant.id, {
          name: "Bad rule",
          priority: 10,
          destinationRef: "x",
          conditions: { field: "answers.not_a_real_field", op: "==", value: true },
        }),
      ).rejects.toBeInstanceOf(RuleValidationError);

      const rules = await prisma.rule.findMany({ where: { tenantId: tenant.id } });
      expect(rules).toHaveLength(0); // never persisted
    });
  });

  describe("invalid rule configuration that slips past save-time validation", () => {
    it("is treated as non-matching, not as a crash, and other rules still get evaluated", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "10");
      await createSuccessfulAnalysis(tenant.id, email.id, defaultAnswers());

      // Bypass validateRule entirely by writing a malformed rule directly, as if
      // it slipped in some other way (e.g. a future schema change) — this is
      // exactly what conditions.ts's per-rule try/catch exists for.
      await prisma.rule.create({
        data: {
          tenantId: tenant.id,
          name: "Somehow malformed",
          priority: 5,
          destinationRef: "broken",
          conditions: { field: "sender.domain", op: ">=", value: 5 } as never, // type-mismatched operator
          enabled: true,
          version: 1,
        },
      });
      await createRule(tenant.id, {
        name: "Valid fallback",
        priority: 10,
        destinationRef: "sales",
        conditions: { field: "answers.is_business_opportunity", op: "==", value: true },
      });

      await evaluateRulesForEmail(email.id);

      const decision = await prisma.routingDecision.findFirstOrThrow({ where: { emailId: email.id, supersededAt: null } });
      expect(decision.status).toBe("matched");
      expect(decision.destinationRef).toBe("sales"); // the broken rule didn't match, but didn't block the valid one either

      const evaluations = await prisma.ruleEvaluation.findMany({ where: { emailId: email.id }, orderBy: { evaluatedAt: "asc" } });
      expect(evaluations).toHaveLength(2);
      expect(evaluations[0]?.matched).toBe(false); // the broken rule, recorded as non-matching with an error trace
    });
  });

  describe("audit trail", () => {
    it("records the full rule evaluation lifecycle", async () => {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "11");
      await createSuccessfulAnalysis(tenant.id, email.id, defaultAnswers());
      await createRule(tenant.id, {
        name: "Rule A",
        priority: 10,
        destinationRef: "sales",
        conditions: { field: "answers.is_business_opportunity", op: "==", value: true },
      });

      await evaluateRulesForEmail(email.id);

      const events = (await prisma.auditEvent.findMany({ where: { emailId: email.id }, orderBy: { createdAt: "asc" } })).map(
        (e) => e.eventType,
      );
      expect(events).toEqual(["rule_evaluation_started", "rule_matched", "routing_decision_created"]);
    });
  });

  describe("Phase 12: RuleGraph execution", () => {
    async function setup(answers: Parameters<typeof defaultAnswers>[0] = {}) {
      const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
      const email = await createReceivedEmail(tenant.id, mailboxConnection.id, `g-${Math.random()}`);
      await createSuccessfulAnalysis(tenant.id, email.id, defaultAnswers(answers));
      // A flat rule that WOULD match — proves the graph takes precedence when assigned.
      await createRule(tenant.id, {
        name: "Flat rule",
        priority: 10,
        destinationRef: "flat-destination",
        conditions: { field: "answers.is_business_opportunity", op: "==", value: true },
      });
      const { graph } = await createRuleGraph(tenant.id, {
        name: "Triage",
        rootNodeKey: "opportunity",
        nodes: [
          {
            key: "opportunity",
            conditions: { field: "answers.is_business_opportunity", op: "==", value: true },
            onTrue: { type: "action", destinationRef: "graph-sales" },
            onFalse: { type: "action", destinationRef: "human_review" },
          },
        ],
      });
      return { tenant, mailboxConnection, email, graph };
    }

    it("a mailbox with an enabled graph assigned is routed by the GRAPH, not the flat rules, with full provenance", async () => {
      const { mailboxConnection, email, graph } = await setup();
      await prisma.mailboxConnection.update({ where: { id: mailboxConnection.id }, data: { ruleGraphId: graph.id } });

      await evaluateRulesForEmail(email.id);

      const decision = await prisma.routingDecision.findFirstOrThrow({ where: { emailId: email.id, supersededAt: null } });
      expect(decision).toMatchObject({ status: "matched", destinationRef: "graph-sales", ruleGraphId: graph.id, ruleGraphVersion: 1, matchedRuleId: null });
      expect((decision.graphPath as Array<{ nodeKey: string; matched: boolean }>).map((s) => [s.nodeKey, s.matched])).toEqual([["opportunity", true]]);
      expect(await prisma.ruleEvaluation.count({ where: { emailId: email.id } })).toBe(0); // flat rules never ran

      const audit = await prisma.auditEvent.findFirst({ where: { emailId: email.id, eventType: "rule_graph_routed" } });
      expect(audit).not.toBeNull();
    });

    it("the graph's latest version is the one that runs", async () => {
      const { mailboxConnection, email, graph } = await setup();
      await updateRuleGraph(graph.id, {
        name: "Triage v2",
        rootNodeKey: "always",
        nodes: [
          {
            key: "always",
            conditions: { field: "subject", op: "!=", value: "__never__" },
            onTrue: { type: "action", destinationRef: "v2-destination" },
            onFalse: { type: "action", destinationRef: "human_review" },
          },
        ],
      });
      await prisma.mailboxConnection.update({ where: { id: mailboxConnection.id }, data: { ruleGraphId: graph.id } });

      await evaluateRulesForEmail(email.id);

      const decision = await prisma.routingDecision.findFirstOrThrow({ where: { emailId: email.id, supersededAt: null } });
      expect(decision).toMatchObject({ destinationRef: "v2-destination", ruleGraphVersion: 2 });
    });

    it("a DISABLED graph falls back to the flat rules", async () => {
      const { mailboxConnection, email, graph } = await setup();
      await prisma.ruleGraph.update({ where: { id: graph.id }, data: { enabled: false } });
      await prisma.mailboxConnection.update({ where: { id: mailboxConnection.id }, data: { ruleGraphId: graph.id } });

      await evaluateRulesForEmail(email.id);

      const decision = await prisma.routingDecision.findFirstOrThrow({ where: { emailId: email.id, supersededAt: null } });
      expect(decision).toMatchObject({ status: "matched", destinationRef: "flat-destination", ruleGraphId: null });
    });

    it("a mailbox with no graph assigned is unaffected — flat rules as before", async () => {
      const { email } = await setup();
      await evaluateRulesForEmail(email.id);
      const decision = await prisma.routingDecision.findFirstOrThrow({ where: { emailId: email.id, supersededAt: null } });
      expect(decision.destinationRef).toBe("flat-destination");
    });

    it("an enabled graph with no active version escalates to Human Review instead of silently using flat rules", async () => {
      const { mailboxConnection, email, graph } = await setup();
      await prisma.ruleGraphVersion.updateMany({ where: { ruleGraphId: graph.id }, data: { deactivatedAt: new Date() } });
      await prisma.mailboxConnection.update({ where: { id: mailboxConnection.id }, data: { ruleGraphId: graph.id } });

      await evaluateRulesForEmail(email.id);

      const decision = await prisma.routingDecision.findFirstOrThrow({ where: { emailId: email.id, supersededAt: null } });
      expect(decision.status).toBe("invalid_config");
      const review = await prisma.humanReviewItem.findMany({ where: { emailId: email.id } });
      expect(review).toHaveLength(1);
    });

    it("the human_review_required override still runs BEFORE the graph", async () => {
      const { mailboxConnection, email, graph } = await setup({ human_review_required: { noul: 0.99 } });
      await prisma.mailboxConnection.update({ where: { id: mailboxConnection.id }, data: { ruleGraphId: graph.id } });
      await evaluateRulesForEmail(email.id);
      const decision = await prisma.routingDecision.findFirstOrThrow({ where: { emailId: email.id, supersededAt: null } });
      expect(decision.status).toBe("human_review_forced");
    });
  });
});
