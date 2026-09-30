import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { assessRuleChange } from "../../src/modules/rules/ruleImpact.js";
import { evaluateRulesForEmail } from "../../src/modules/rules/evaluateRulesForEmail.js";
import { createRule } from "../../src/modules/rules/manageRules.js";
import { buildTestServer } from "../api/helpers/buildTestServer.js";
import { createReceivedEmail, createSuccessfulAnalysis, createTestTenantAndMailbox, defaultAnswers, resetDatabase } from "../helpers/db.js";

const invoice = (subject: string) => ({ subject, answers: defaultAnswers({ category: { choice: "invoice", probabilities: {}, confidence: 0.9 }, is_spam: { noul: 0.05 } }) });
const promo = (subject: string) => ({ subject, answers: defaultAnswers({ category: { choice: "marketing", probabilities: {}, confidence: 0.9 }, is_spam: { noul: 0.4 }, is_customer_related: { noul: 0.1 } }) });

async function setup() {
  const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
  for (const [name, folder] of [["Finans", "Finans"], ["Junk", "INBOX.Junk"]] as const) {
    const d = await prisma.destination.create({ data: { tenantId: tenant.id, name } });
    await prisma.destinationChannel.create({ data: { tenantId: tenant.id, destinationId: d.id, type: "archive", config: { folder }, version: 1 } });
  }
  const mails = [invoice("Fatura 2026-09"), invoice("Ödeme hatırlatma"), invoice("Makbuzunuz"), promo("Kampanya"), promo("Yeni ürünler")];
  const ids: string[] = [];
  for (const [i, m] of mails.entries()) {
    const e = await createReceivedEmail(tenant.id, mailboxConnection.id, `${i}`, { subject: m.subject });
    await createSuccessfulAnalysis(tenant.id, e.id, m.answers);
    ids.push(e.id);
  }
  return { tenant, ids };
}

// "invoice category OR subject contains fatura" — the AND version only matches invoices whose subject also says fatura.
const invoiceConditions = (op: "AND" | "OR") => ({ op, children: [{ field: "answers.category", op: "==", value: "invoice" }, { field: "subject", op: "contains", value: "fatura" }] });

describe("rule change impact (checked before saving)", () => {
  beforeEach(resetDatabase);

  it("regression: AND vs OR in the same rule reach a different number of emails, and the check says how many move", async () => {
    const { tenant, ids } = await setup();
    const rule = await createRule(tenant.id, { name: "Fatura", priority: 10, destinationRef: "Finans", conditions: invoiceConditions("OR") as never });
    for (const id of ids) await evaluateRulesForEmail(id);

    const toAnd = await assessRuleChange(tenant.id, { type: "update", ruleId: rule.id, rule: { name: "Fatura", priority: 10, destinationRef: "Finans", conditions: invoiceConditions("AND") as never } });
    expect(toAnd).toMatchObject({ evaluated: 5, currentMatches: 3, draftMatches: 1, changed: 2, divergence: 0 });
    expect(toAnd.moves).toEqual([{ from: "Finans", to: "human_review", count: 2 }]);
    expect(toAnd.risky.count).toBe(0); // Human Review is not a sink
  });

  it("refuses a change that sends business mail to Junk unless confirmed; the preview explains it", async () => {
    const { tenant, ids } = await setup();
    await createRule(tenant.id, { name: "Fatura", priority: 10, destinationRef: "Finans", conditions: invoiceConditions("OR") as never });
    for (const id of ids) await evaluateRulesForEmail(id);
    const app = buildTestServer(tenant.id);
    // A careless spam rule placed first: is_spam >= 0.01 catches everything, invoices included.
    const careless = { name: "Spam", priority: 1, destinationRef: "Junk", conditions: { field: "answers.is_spam", op: ">=", value: 0.01 } };

    const preview = (await app.inject({ method: "POST", url: "/api/v1/rules/impact", payload: { change: { type: "create", rule: careless } } })).json();
    expect(preview.risky.count).toBe(3);
    expect(preview.risky.samples[0]).toMatchObject({ from: "Finans", to: "Junk", reason: expect.stringContaining("Finans") });
    expect(preview.moves).toEqual(expect.arrayContaining([{ from: "Finans", to: "Junk", count: 3 }, { from: "human_review", to: "Junk", count: 2 }]));

    const refused = await app.inject({ method: "POST", url: "/api/v1/rules", payload: careless });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.details.impact.risky.count).toBe(3);
    expect(await prisma.rule.count({ where: { tenantId: tenant.id, name: "Spam" } })).toBe(0);

    const confirmed = await app.inject({ method: "POST", url: "/api/v1/rules", payload: { ...careless, confirmImpact: true } });
    expect(confirmed.statusCode).toBe(201);

    // A harmless rule saves without any confirmation.
    const fine = await app.inject({ method: "POST", url: "/api/v1/rules", payload: { name: "Promo", priority: 20, destinationRef: "Junk", conditions: { field: "answers.category", op: "==", value: "marketing" } } });
    expect(fine.statusCode).toBe(201);
  });

  it("deleting a rule that protects business mail from a later Junk rule is risky too; shadowing is reported", async () => {
    const { tenant, ids } = await setup();
    const keep = await createRule(tenant.id, { name: "Fatura", priority: 10, destinationRef: "Finans", conditions: invoiceConditions("OR") as never });
    await createRule(tenant.id, { name: "Low spam", priority: 20, destinationRef: "Junk", conditions: { field: "answers.is_spam", op: ">=", value: 0.01 } });
    for (const id of ids) await evaluateRulesForEmail(id);
    const app = buildTestServer(tenant.id);

    expect((await app.inject({ method: "DELETE", url: `/api/v1/rules/${keep.id}` })).statusCode).toBe(409);
    expect((await prisma.rule.findUniqueOrThrow({ where: { id: keep.id } })).deactivatedAt).toBeNull();

    const shadow = await assessRuleChange(tenant.id, { type: "create", rule: { name: "Promo late", priority: 30, destinationRef: "Bultenler", conditions: { field: "answers.category", op: "==", value: "marketing" } as never } });
    expect(shadow.draftMatches).toBe(0);
    expect(shadow.shadowedBy).toEqual([{ by: 'rule "Low spam"', count: 2 }]);
    expect(shadow.warnings.join(" ")).toMatch(/earlier rules take all of them/);

    expect((await app.inject({ method: "DELETE", url: `/api/v1/rules/${keep.id}?confirmImpact=true` })).statusCode).toBe(204);
  });
});
