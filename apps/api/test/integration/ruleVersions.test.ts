import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { createRule, deactivateRule, updateRule } from "../../src/modules/rules/manageRules.js";
import { listRuleVersions, revertRule } from "../../src/modules/rules/ruleVersions.js";
import { evaluateRulesForEmail } from "../../src/modules/rules/evaluateRulesForEmail.js";
import { buildTestServer } from "../api/helpers/buildTestServer.js";
import { createArchiveDestination, createReceivedEmail, createSuccessfulAnalysis, createTestTenantAndMailbox, defaultAnswers, resetDatabase } from "../helpers/db.js";

const OR = { op: "OR", children: [{ field: "answers.category", op: "==", value: "invoice" }, { field: "subject", op: "contains", value: "fatura" }] } as const;
const AND = { ...OR, op: "AND" } as const;

describe("Phase 25 — rule history and going back", () => {
  beforeEach(resetDatabase);

  it("lists every version as one lineage even after a rename, and going back saves a NEW version", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const v1 = await createRule(tenant.id, { name: "Fatura", priority: 10, destinationRef: "Finans", conditions: OR as never });
    expect(v1.lineageId).toBe(v1.id);
    const v2 = await updateRule(v1.id, { name: "Fatura ve ödeme", priority: 10, destinationRef: "Finans", conditions: AND as never });
    expect(v2.lineageId).toBe(v1.id);

    const history = await listRuleVersions(tenant.id, v2.id);
    expect(history.map((h) => [h.version, h.name, h.active])).toEqual([[1, "Fatura", false], [2, "Fatura ve ödeme", true]]);

    const back = await revertRule(tenant.id, v2.id, 1, "ops@acme.test");
    expect(back.restored).toBe(false);
    expect(back.rule).toMatchObject({ version: 3, name: "Fatura", lineageId: v1.id });
    expect(back.rule.conditions).toEqual(OR);
    expect((await listRuleVersions(tenant.id, v1.id)).map((h) => h.version)).toEqual([1, 2, 3]);
    await expect(revertRule(tenant.id, back.rule.id, 1, "x")).rejects.toMatchObject({ code: "same_as_current" });
    expect(await prisma.auditEvent.count({ where: { eventType: "rule_reverted", actor: "ops@acme.test" } })).toBe(1);
  });

  it("restores a deleted rule into its own lineage; a taken priority must be changed", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const v1 = await createRule(tenant.id, { name: "Old", priority: 10, destinationRef: "X", conditions: OR as never });
    await deactivateRule(tenant.id, v1.id);
    await createRule(tenant.id, { name: "Newcomer", priority: 10, destinationRef: "Y", conditions: AND as never });

    await expect(revertRule(tenant.id, v1.id, 1, "x")).rejects.toMatchObject({ code: "priority_taken" });
    const restored = await revertRule(tenant.id, v1.id, 1, "x", { priority: 11 });
    expect(restored).toMatchObject({ restored: true, rule: { version: 2, priority: 11, lineageId: v1.id, deactivatedAt: null } });
  });

  it("API: history and revert; a risky revert needs confirmation", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    await createArchiveDestination(tenant.id, "Junk", "INBOX.Junk");
    await createArchiveDestination(tenant.id, "Finans", "Finans");
    // v1 sent invoices to Junk (the mistake), v2 fixed it to Finans.
    const v1 = await createRule(tenant.id, { name: "Fatura", priority: 10, destinationRef: "Junk", conditions: OR as never });
    const v2 = await updateRule(v1.id, { name: "Fatura", priority: 10, destinationRef: "Finans", conditions: OR as never });
    for (const uid of ["1", "2"]) {
      const e = await createReceivedEmail(tenant.id, mailboxConnection.id, uid, { subject: "Fatura" });
      await createSuccessfulAnalysis(tenant.id, e.id, defaultAnswers({ category: { choice: "invoice", probabilities: {}, confidence: 0.9 } }));
      await evaluateRulesForEmail(e.id);
    }
    const app = buildTestServer(tenant.id);
    const versions = (await app.inject({ method: "GET", url: `/api/v1/rules/${v2.id}/versions` })).json().data;
    expect(versions.map((v: { version: number; matches: number }) => [v.version, v.matches])).toEqual([[1, 0], [2, 2]]);

    const risky = await app.inject({ method: "POST", url: `/api/v1/rules/${v2.id}/revert`, payload: { version: 1 } });
    expect(risky.statusCode).toBe(409);
    expect(risky.json().error.details.impact.risky.count).toBe(2);
    const confirmed = await app.inject({ method: "POST", url: `/api/v1/rules/${v2.id}/revert`, payload: { version: 1, confirmImpact: true } });
    expect(confirmed.json()).toMatchObject({ restored: false, rule: { version: 3, destinationRef: "Junk" } });
  });
});
