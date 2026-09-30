import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { analyzeEmail } from "../../src/modules/jev/analyzeEmail.js";
import { evaluateRulesForEmail } from "../../src/modules/rules/evaluateRulesForEmail.js";
import { createRule } from "../../src/modules/rules/manageRules.js";
import { computeDerivedFields, isWithinBusinessHours, validateBusinessHours } from "../../src/modules/rules/derivedFields.js";
import { simulateRouting } from "../../src/modules/rules/simulateRouting.js";
import { reprocessEmail } from "../../src/modules/reprocess/reprocessEmail.js";
import { createQuestion } from "../../src/modules/questions/tenantQuestions.js";
import { buildTestServer } from "../api/helpers/buildTestServer.js";
import { buildValidJevResponseBody, createSequencedFetch, fakeClientFactory, okStep, type CapturedRequest } from "../fixtures/jevFixtures.js";
import { createReceivedEmail, createSuccessfulAnalysis, createTestTenantAndMailbox, defaultAnswers, resetDatabase } from "../helpers/db.js";

const H = 60 * 60 * 1000;

describe("Phase 22 — custom Jev questions", () => {
  beforeEach(resetDatabase);

  it("API: creates, validates, lists usage, and refuses to delete a question a rule uses", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const app = buildTestServer(tenant.id);
    const post = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/v1/questions", payload });

    const invoice = await post({ key: "is_invoice_overdue", type: "noul", instructions: "Does this email say an invoice is overdue?", criteria: { true: "A payment deadline has passed" } });
    expect(invoice.statusCode).toBe(201);
    expect(invoice.json()).toMatchObject({ field: "answers.is_invoice_overdue", criteria: { true: "A payment deadline has passed" } });
    expect((await post({ key: "dept", type: "choice", instructions: "Which department?", criteria: { billing: "Money", tech: "Tech" } })).statusCode).toBe(201);
    expect((await post({ key: "tone", type: "score", instructions: "How angry is the sender?", criteria: ["calm", "annoyed", "furious"] })).statusCode).toBe(201);

    expect((await post({ key: "is_spam", type: "noul", instructions: "x" })).json().error.message).toMatch(/built-in/);
    expect((await post({ key: "Bad Key", type: "noul", instructions: "x" })).statusCode).toBe(400);
    expect((await post({ key: "dept2", type: "choice", instructions: "x", criteria: { only: "one" } })).statusCode).toBe(400);
    expect((await post({ key: "lvl", type: "score", instructions: "x", criteria: ["a"] })).statusCode).toBe(400);
    expect((await post({ key: "dept", type: "noul", instructions: "again" })).statusCode).toBe(400);

    // Rule validation now knows the new fields (and their types).
    const ok = await app.inject({ method: "POST", url: "/api/v1/rules", payload: { name: "Overdue", priority: 1, destinationRef: "finance", conditions: { op: "AND", children: [{ field: "answers.is_invoice_overdue", op: ">=", value: 0.8 }, { field: "answers.dept", op: "==", value: "billing" }] } } });
    expect(ok.statusCode, ok.body).toBe(201);
    const wrongType = await app.inject({ method: "POST", url: "/api/v1/rules", payload: { name: "X", priority: 2, destinationRef: "x", conditions: { field: "answers.dept", op: ">=", value: 1 } } });
    expect(wrongType.statusCode).toBe(400);

    const list = (await app.inject({ method: "GET", url: "/api/v1/questions" })).json();
    expect(list.data.map((q: { key: string }) => q.key)).toEqual(["is_invoice_overdue", "dept", "tone"]);
    expect(list.data[0].usedBy).toEqual(['rule "Overdue"']);

    const fields = (await app.inject({ method: "GET", url: "/api/v1/rules/fields" })).json().data;
    expect(fields).toEqual(expect.arrayContaining([
      { field: "answers.dept", type: "string", source: "custom" },
      { field: "answers.tone.confidence", type: "number", source: "custom" },
      { field: "sender.first_email", type: "boolean", source: "derived" },
    ]));

    const id = list.data[0].id;
    const refused = await app.inject({ method: "DELETE", url: `/api/v1/questions/${id}` });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.details).toEqual({ usedBy: ['rule "Overdue"'] });
    expect((await app.inject({ method: "DELETE", url: `/api/v1/questions/${id}?force=true` })).statusCode).toBe(204);
    expect((await post({ key: "is_invoice_overdue", type: "noul", instructions: "reuse" })).json().error.message).toMatch(/deleted question/);
  });

  it("asks Jev the organization's questions with the built-in ones; a malformed custom answer is skipped, not fatal", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    await createQuestion(tenant.id, { key: "dept", type: "choice", instructions: "Which department?", criteria: { billing: "Money", tech: "Tech" } }, "admin");
    await createQuestion(tenant.id, { key: "is_legal", type: "noul", instructions: "Is this a legal notice?" }, "admin");
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
    const captured: CapturedRequest[] = [];
    const fetch = createSequencedFetch(
      [okStep(buildValidJevResponseBody({ answers: { dept: { choice: "billing", probabilities: { billing: 0.9, tech: 0.1 }, confidence: 0.9 }, is_legal: { noul: "not a number" } } }))],
      captured,
    );
    await analyzeEmail(email.id, fakeClientFactory(fetch));

    const sent = captured[0]!.parsedBody as { questions: Record<string, { instructions: string }>; state: { body: string } };
    expect(Object.keys(sent.questions)).toEqual(expect.arrayContaining(["is_spam", "category", "dept", "is_legal"]));
    expect(sent.questions.dept!.instructions).toBe("Which department?");

    const analysis = await prisma.analysisResult.findFirstOrThrow({ where: { emailId: email.id, status: "ok" } });
    const answers = analysis.answers as Record<string, unknown>;
    expect(answers.dept).toMatchObject({ choice: "billing" });
    expect(answers.is_legal).toBeUndefined();
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { emailId: email.id, eventType: "analysis_succeeded" } });
    expect(audit.payload).toMatchObject({ customQuestionsSkipped: ["is_legal"] });
  });

  it("reprocess can ask Jev again (picking up new questions); refused when the content was removed", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
    await createSuccessfulAnalysis(tenant.id, email.id, defaultAnswers());
    await evaluateRulesForEmail(email.id);
    await createQuestion(tenant.id, { key: "is_legal", type: "noul", instructions: "Is this a legal notice?" }, "admin");
    await createRule(tenant.id, { name: "Legal", priority: 1, destinationRef: "human_review", conditions: { field: "answers.is_legal", op: ">=", value: 0.5 } });

    const fetch = createSequencedFetch([okStep(buildValidJevResponseBody({ answers: { is_legal: { noul: 0.9 } } }))]);
    const result = await reprocessEmail(tenant.id, email.id, "admin", { reanalyze: true, jevClientFactory: fakeClientFactory(fetch) });
    expect(result.decision).toMatchObject({ status: "matched", destinationRef: "human_review" });
    expect(await prisma.analysisResult.count({ where: { emailId: email.id, status: "ok" } })).toBe(2);

    await prisma.email.update({ where: { id: email.id }, data: { bodyPurgedAt: new Date() } });
    await expect(reprocessEmail(tenant.id, email.id, "admin", { reanalyze: true })).rejects.toMatchObject({ code: "content_removed" });
  });
});

describe("Phase 22 — derived conditions", () => {
  beforeEach(resetDatabase);

  it("business hours: weekdays, time zone and overnight windows", () => {
    const office = { timeZone: "Europe/Istanbul", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };
    expect(isWithinBusinessHours(new Date("2026-09-28T07:30:00Z"), office)).toBe(true); // Mon 10:30 Istanbul
    expect(isWithinBusinessHours(new Date("2026-09-28T05:30:00Z"), office)).toBe(false); // Mon 08:30
    expect(isWithinBusinessHours(new Date("2026-09-27T09:00:00Z"), office)).toBe(false); // Sunday
    const night = { timeZone: "UTC", days: [5], start: "22:00", end: "06:00" };
    expect(isWithinBusinessHours(new Date("2026-10-02T23:00:00Z"), night)).toBe(true); // Fri 23:00
    expect(isWithinBusinessHours(new Date("2026-10-03T05:00:00Z"), night)).toBe(true); // Sat 05:00, Friday's night
    expect(isWithinBusinessHours(new Date("2026-10-03T23:00:00Z"), night)).toBe(false); // Sat night
    expect(validateBusinessHours({ timeZone: "Mars/Base", days: [8], start: "9", end: "9" })).toHaveLength(3);
  });

  it("sender history and reply are computed as of arrival, identically for live routing and simulation", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    await prisma.tenant.update({ where: { id: tenant.id }, data: { businessHours: { timeZone: "UTC", days: [1, 2, 3, 4, 5, 6, 7], start: "00:00", end: "12:00" } } });
    const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * H);
    const mk = async (uid: string, from: string, hoursAgo: number, reply?: string) => {
      const e = await createReceivedEmail(tenant.id, mailboxConnection.id, uid, { fromAddress: from });
      await prisma.email.update({ where: { id: e.id }, data: { receivedAt: at(hoursAgo), threadHeadersCaptured: uid !== "old", inReplyTo: reply ?? null } });
      return prisma.email.findUniqueOrThrow({ where: { id: e.id } });
    };
    const first = await mk("1", "Ayse@Example.com", 30);
    const second = await mk("2", "ayse@example.com", 5, "<x@y>");
    const third = await mk("3", "ayse@example.com", 1);
    const old = await mk("old", "bob@example.com", 2);

    const derived = await computeDerivedFields(tenant.id, [first, second, third, old], (await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).businessHours);
    expect(derived.get(first.id)).toMatchObject({ firstFromSender: true, senderLast24h: 0, isReply: false });
    expect(derived.get(second.id)).toMatchObject({ firstFromSender: false, senderLast24h: 0, isReply: true });
    expect(derived.get(third.id)).toMatchObject({ firstFromSender: false, senderLast24h: 1 });
    expect(derived.get(old.id)!.isReply).toBeUndefined();
    expect(typeof derived.get(first.id)!.businessHours).toBe("boolean");

    await createRule(tenant.id, { name: "Newcomer", priority: 1, destinationRef: "welcome", conditions: { field: "sender.first_email", op: "==", value: true } });
    await createRule(tenant.id, { name: "Chatty", priority: 2, destinationRef: "chatty", conditions: { field: "sender.emails_last_24h", op: ">=", value: 1 } });
    for (const e of [first, second, third, old]) {
      await createSuccessfulAnalysis(tenant.id, e.id, defaultAnswers());
      await evaluateRulesForEmail(e.id);
    }
    const live = new Map((await prisma.routingDecision.findMany({ where: { tenantId: tenant.id } })).map((d) => [d.emailId, d.destinationRef]));
    expect(live.get(first.id)).toBe("welcome");
    expect(live.get(old.id)).toBe("welcome");
    expect(live.get(third.id)).toBe("chatty");
    expect(live.get(second.id)).toBeNull();

    const sim = await simulateRouting(tenant.id, { type: "current" });
    expect(sim.changed).toBe(0);
  });
});
