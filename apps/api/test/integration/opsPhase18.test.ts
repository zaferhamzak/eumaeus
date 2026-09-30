import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: Array<{ to: string; subject: string; html?: string; inlineImages?: unknown[] }> = [];
vi.mock("../../src/modules/email/mailer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/modules/email/mailer.js")>()),
  isMailerConfigured: async () => true,
  sendEmail: async (input: { to: string; subject: string; html?: string; inlineImages?: unknown[] }) => {
    sent.push(input);
  },
}));

const { prisma } = await import("../../src/db/client.js");
const { evaluateRulesForEmail } = await import("../../src/modules/rules/evaluateRulesForEmail.js");
const { createRule, updateRule } = await import("../../src/modules/rules/manageRules.js");
const { reprocessEmail, ReprocessRefusedError } = await import("../../src/modules/reprocess/reprocessEmail.js");
const { evaluateTenant } = await import("../../src/modules/alerts/evaluateAlerts.js");
const { buildReport } = await import("../../src/modules/reports/buildReport.js");
const { createReceivedEmail, createSuccessfulAnalysis, createTestTenantAndMailbox, defaultAnswers, resetDatabase } = await import("../helpers/db.js");
const { createTestMembership, createTestUser } = await import("../helpers/auth.js");

const MARKETING = { field: "answers.category", op: "==", value: "marketing" } as const;

async function analyzedEmail(tenantId: string, mailboxId: string, uid: string, answers = defaultAnswers()) {
  const e = await createReceivedEmail(tenantId, mailboxId, uid);
  await createSuccessfulAnalysis(tenantId, e.id, answers);
  return e;
}

describe("reprocessing (Phase 18)", () => {
  beforeEach(async () => {
    await resetDatabase();
    sent.length = 0;
  });

  it("re-routes with today's rules: the old decision is kept as superseded, open review closed, new decision made", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await analyzedEmail(tenant.id, mailboxConnection.id, "1", defaultAnswers({ category: { choice: "marketing", probabilities: {}, confidence: 0.9 } }));
    await evaluateRulesForEmail(email.id); // no rules yet -> unmatched -> Human Review
    await prisma.humanReviewItem.create({ data: { tenantId: tenant.id, emailId: email.id, reason: "unmatched", status: "open" } });
    await createRule(tenant.id, { name: "Marketing", priority: 1, conditions: MARKETING, destinationRef: "human_review" });

    const result = await reprocessEmail(tenant.id, email.id, "admin@acme.test");

    expect(result.decision).toMatchObject({ status: "matched", destinationRef: "human_review", supersededAt: null });
    const all = await prisma.routingDecision.findMany({ where: { emailId: email.id }, orderBy: { createdAt: "asc" } });
    expect(all.map((d) => [d.status, d.supersededAt !== null])).toEqual([["unmatched", true], ["matched", false]]);
    expect(await prisma.auditEvent.count({ where: { eventType: "email_reprocessed", actor: "admin@acme.test" } })).toBe(1);
  });

  it("reprocessing closes open review items as superseded, which never count as a person's decision", async () => {
    const { refreshSuggestions } = await import("../../src/modules/review/suggestions.js");
    const { resolveReviewItem } = await import("../../src/modules/review/resolveReview.js");
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    // Six emails from one sender, each sent to review and then reprocessed.
    for (let i = 0; i < 6; i += 1) {
      const e = await createReceivedEmail(tenant.id, mailboxConnection.id, `s${i}`, { fromAddress: "news@shop.test" });
      await createSuccessfulAnalysis(tenant.id, e.id, defaultAnswers());
      await evaluateRulesForEmail(e.id);
      await reprocessEmail(tenant.id, e.id, "admin@acme.test");
    }
    const items = await prisma.humanReviewItem.findMany({ where: { tenantId: tenant.id } });
    expect(new Set(items.filter((i) => i.status !== "open").map((i) => `${i.status}|${i.resolution}`))).toEqual(new Set(["superseded|null"]));
    expect(await refreshSuggestions(tenant.id)).toEqual([]);

    // A superseded item can't be "resolved" afterwards.
    const superseded = items.find((i) => i.status === "superseded")!;
    expect((await resolveReviewItem(tenant.id, superseded.id, "spam"))?.status).toBe("superseded");

    // People's decisions still are evidence: five senders' emails marked spam by hand.
    for (let i = 0; i < 5; i += 1) {
      const e = await createReceivedEmail(tenant.id, mailboxConnection.id, `p${i}`, { fromAddress: "promo@spam.test" });
      await createSuccessfulAnalysis(tenant.id, e.id, defaultAnswers());
      await evaluateRulesForEmail(e.id);
      const open = await prisma.humanReviewItem.findFirstOrThrow({ where: { emailId: e.id, status: "open" } });
      await resolveReviewItem(tenant.id, open.id, "spam");
    }
    expect((await refreshSuggestions(tenant.id)).map((s) => [s.kind, s.pattern])).toEqual([["block", "promo@spam.test"]]);
  });

  it("the database allows only one current decision per email", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await analyzedEmail(tenant.id, mailboxConnection.id, "1");
    await prisma.routingDecision.create({ data: { tenantId: tenant.id, emailId: email.id, status: "unmatched" } });
    await expect(prisma.routingDecision.create({ data: { tenantId: tenant.id, emailId: email.id, status: "unmatched" } })).rejects.toMatchObject({ code: "P2002" });
    await prisma.routingDecision.updateMany({ data: { supersededAt: new Date() } });
    await expect(prisma.routingDecision.create({ data: { tenantId: tenant.id, emailId: email.id, status: "unmatched" } })).resolves.toBeDefined();
  });

  it("refuses while the email sits in another folder from an earlier move — until that move is undone", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await analyzedEmail(tenant.id, mailboxConnection.id, "1");
    const destination = await prisma.destination.create({ data: { tenantId: tenant.id, name: "Junk" } });
    const channel = await prisma.destinationChannel.create({ data: { tenantId: tenant.id, destinationId: destination.id, type: "archive", config: { folder: "Junk" }, version: 1 } });
    const decision = await prisma.routingDecision.create({ data: { tenantId: tenant.id, emailId: email.id, status: "matched", destinationRef: "Junk" } });
    const move = await prisma.actionExecution.create({
      data: { tenantId: tenant.id, emailId: email.id, routingDecisionId: decision.id, destinationChannelId: channel.id, channelType: "archive", channelVersion: 1, idempotencyKey: "k", attemptNumber: 1, status: "succeeded", responseMetadata: { moved: true, targetFolder: "Junk" } },
    });

    await expect(reprocessEmail(tenant.id, email.id, "a")).rejects.toMatchObject({ code: "moved_elsewhere" });

    await prisma.actionExecution.create({
      data: { tenantId: tenant.id, emailId: email.id, routingDecisionId: decision.id, destinationChannelId: channel.id, channelType: "archive_undo", channelVersion: 1, idempotencyKey: `undo:${move.id}`, attemptNumber: 1, status: "succeeded" },
    });
    await expect(reprocessEmail(tenant.id, email.id, "a")).resolves.toBeDefined();
  });

  it("refuses while an action is still running, and for an unknown email", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await analyzedEmail(tenant.id, mailboxConnection.id, "1");
    const destination = await prisma.destination.create({ data: { tenantId: tenant.id, name: "X" } });
    const channel = await prisma.destinationChannel.create({ data: { tenantId: tenant.id, destinationId: destination.id, type: "webhook", config: { url: "https://x.test" }, version: 1 } });
    const decision = await prisma.routingDecision.create({ data: { tenantId: tenant.id, emailId: email.id, status: "matched", destinationRef: "X" } });
    await prisma.actionExecution.create({ data: { tenantId: tenant.id, emailId: email.id, routingDecisionId: decision.id, destinationChannelId: channel.id, channelType: "webhook", channelVersion: 1, idempotencyKey: "p", attemptNumber: 1, status: "pending" } });
    await expect(reprocessEmail(tenant.id, email.id, "a")).rejects.toMatchObject({ code: "in_progress" });
    await expect(reprocessEmail(tenant.id, "missing", "a")).rejects.toBeInstanceOf(ReprocessRefusedError);
  });

  it("rule edits don't confuse it: an edited rule's new version decides", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const email = await analyzedEmail(tenant.id, mailboxConnection.id, "1", defaultAnswers({ category: { choice: "marketing", probabilities: {}, confidence: 0.9 } }));
    const rule = await createRule(tenant.id, { name: "M", priority: 1, conditions: { field: "subject", op: "contains", value: "zzz" }, destinationRef: "human_review" });
    await evaluateRulesForEmail(email.id);
    const v2 = await updateRule(rule.id, { name: "M", priority: 1, conditions: MARKETING, destinationRef: "human_review" });
    const result = await reprocessEmail(tenant.id, email.id, "a");
    expect(result.decision).toMatchObject({ status: "matched", matchedRuleId: v2.id });
  });
});

describe("operational alerts (Phase 18)", () => {
  beforeEach(async () => {
    await resetDatabase();
    sent.length = 0;
  });

  async function orgWithAdmin() {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const admin = await createTestUser({ email: "ops-admin@acme.test" });
    await createTestMembership(admin.id, tenant.id, ["organizations:write"]);
    const reader = await createTestUser({ email: "reader@acme.test" });
    await createTestMembership(reader.id, tenant.id, ["emails:read"]);
    return { tenant: await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } }), mailboxConnection };
  }

  it("1.2: a Turkish-speaking admin gets the alert email in Turkish, title and detail included", async () => {
    const { tenant, mailboxConnection } = await orgWithAdmin();
    await prisma.user.updateMany({ where: { email: "ops-admin@acme.test" }, data: { locale: "tr" } });
    const now = new Date();
    await prisma.mailboxConnection.update({
      where: { id: mailboxConnection.id },
      data: { lastSyncSuccessAt: new Date(now.getTime() - 45 * 60_000), lastSyncFailureAt: new Date(now.getTime() - 60_000), lastSyncError: "Socket timeout" },
    });
    await evaluateTenant(tenant, now);
    expect(sent[0]!.subject).toBe(`${mailboxConnection.emailAddress} senkronlanamıyor (${tenant.name}, Eumaeus)`);
    expect(sent[0]!.html).toContain("tarihinden beri başarılı senkron yok. Son hata: Socket timeout");
  });

  it("a mailbox failing for 30 minutes opens one alert, emails admins once, and resolves when sync succeeds", async () => {
    const { tenant, mailboxConnection } = await orgWithAdmin();
    const now = new Date();
    await prisma.mailboxConnection.update({
      where: { id: mailboxConnection.id },
      data: { lastSyncSuccessAt: new Date(now.getTime() - 45 * 60_000), lastSyncFailureAt: new Date(now.getTime() - 60_000), lastSyncError: "Command failed" },
    });

    expect(await evaluateTenant(tenant, now)).toEqual({ opened: 1, resolved: 0 });
    expect(await evaluateTenant(tenant, new Date(now.getTime() + 5 * 60_000))).toEqual({ opened: 0, resolved: 0 });
    expect(sent.map((m) => m.to)).toEqual(["ops-admin@acme.test"]);
    expect(sent[0]!.subject).toContain("can't be synced");
    // 1.0.2: the designed message — advice for this kind, a button to Mailboxes, the logo inline.
    expect(sent[0]!.html).toContain("What to do");
    expect(sent[0]!.html).toContain(`/organizations/${tenant.id}"`);
    expect(sent[0]!.html).toMatch(/href="[^"]*\/mailboxes"/);
    expect(sent[0]!.inlineImages).toHaveLength(1);

    await prisma.mailboxConnection.update({ where: { id: mailboxConnection.id }, data: { lastSyncSuccessAt: new Date(now.getTime() + 6 * 60_000) } });
    expect(await evaluateTenant(tenant, new Date(now.getTime() + 10 * 60_000))).toEqual({ opened: 0, resolved: 1 });
    expect(sent.at(-1)!.subject).toMatch(/^Resolved: /);
    // 1.2 (E): the alert keeps the values its text is built from.
    expect((await prisma.alert.findFirstOrThrow()).params).toMatchObject({ mailbox: mailboxConnection.emailAddress, error: "Command failed" });
    expect(await prisma.alert.findFirstOrThrow()).toMatchObject({ status: "resolved", kind: "mailbox_sync_failing" });
  });

  it("a dismissed alert stays closed and quiet while the problem lasts, resolves silently, and a recurrence opens a new one", async () => {
    const { tenant, mailboxConnection } = await orgWithAdmin();
    const { dismissAlert, AlertNotOpenError } = await import("../../src/modules/alerts/evaluateAlerts.js");
    const now = new Date();
    const failing = { lastSyncSuccessAt: new Date(now.getTime() - 45 * 60_000), lastSyncFailureAt: new Date(now.getTime() - 60_000), lastSyncError: "Command failed" };
    await prisma.mailboxConnection.update({ where: { id: mailboxConnection.id }, data: failing });
    await evaluateTenant(tenant, now);
    const alert = await prisma.alert.findFirstOrThrow();
    sent.length = 0;

    expect(await dismissAlert(tenant.id, alert.id, "ops-admin@acme.test", now)).toMatchObject({ status: "dismissed", dismissedBy: "ops-admin@acme.test" });
    await expect(dismissAlert(tenant.id, alert.id, "x", now)).rejects.toBeInstanceOf(AlertNotOpenError);
    expect(await dismissAlert("other-tenant", alert.id, "x", now)).toBeNull();

    // Still failing, a day later: no new alert, no reminder email.
    expect(await evaluateTenant(tenant, new Date(now.getTime() + 25 * 60 * 60_000))).toEqual({ opened: 0, resolved: 0 });
    expect(await prisma.alert.count({ where: { status: "open" } })).toBe(0);
    expect(sent).toHaveLength(0);

    // Problem clears: resolved without a "Resolved:" email.
    await prisma.mailboxConnection.update({ where: { id: mailboxConnection.id }, data: { lastSyncSuccessAt: new Date(now.getTime() + 26 * 60 * 60_000) } });
    expect(await evaluateTenant(tenant, new Date(now.getTime() + 26 * 60 * 60_000 + 60_000))).toEqual({ opened: 0, resolved: 1 });
    expect(await prisma.alert.findUniqueOrThrow({ where: { id: alert.id } })).toMatchObject({ status: "resolved" });
    expect(sent).toHaveLength(0);

    // It happens again later: a fresh alert, notified as usual.
    const later = new Date(now.getTime() + 30 * 60 * 60_000);
    await prisma.mailboxConnection.update({ where: { id: mailboxConnection.id }, data: { lastSyncSuccessAt: new Date(later.getTime() - 45 * 60_000), lastSyncFailureAt: later } });
    expect((await evaluateTenant(tenant, later)).opened).toBe(1);
    expect(sent).toHaveLength(1);
    expect(await prisma.auditEvent.count({ where: { tenantId: tenant.id, eventType: "alert_dismissed", actor: "ops-admin@acme.test" } })).toBe(1);
  });

  it("a short failure isn't an alert; an expired sign-in is", async () => {
    const { tenant, mailboxConnection } = await orgWithAdmin();
    const now = new Date();
    await prisma.mailboxConnection.update({ where: { id: mailboxConnection.id }, data: { lastSyncSuccessAt: new Date(now.getTime() - 10 * 60_000), lastSyncFailureAt: now } });
    expect((await evaluateTenant(tenant, now)).opened).toBe(0);

    await prisma.mailboxConnection.update({ where: { id: mailboxConnection.id }, data: { status: "reauth_required" } });
    expect((await evaluateTenant(tenant, now)).opened).toBe(1);
    expect((await prisma.alert.findFirstOrThrow()).kind).toBe("mailbox_reauth_required");
  });

  it("a burst of Jev errors opens an alert; alert emails can be switched off", async () => {
    const { tenant, mailboxConnection } = await orgWithAdmin();
    await prisma.tenant.update({ where: { id: tenant.id }, data: { alertEmailsEnabled: false } });
    for (let i = 0; i < 5; i += 1) {
      const e = await createReceivedEmail(tenant.id, mailboxConnection.id, `j${i}`);
      await prisma.analysisResult.create({ data: { tenantId: tenant.id, emailId: e.id, schemaVersion: "v1", jevModel: "jev", status: "error", errorClass: "http_503", inputTokens: 0, outputTokens: 0 } });
    }
    expect((await evaluateTenant(await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } }), new Date())).opened).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it("a single refusal from Jev (no credits / plan / key) opens an alert at once, and it clears when an analysis succeeds", async () => {
    const { tenant, mailboxConnection } = await orgWithAdmin();
    const org = () => prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    const e = await createReceivedEmail(tenant.id, mailboxConnection.id, "r1");
    await prisma.analysisResult.create({
      data: { tenantId: tenant.id, emailId: e.id, schemaVersion: "v1", jevModel: "jev", status: "error", errorClass: "unexpected_status", inputTokens: 0, outputTokens: 0,
        errorMessage: 'Unexpected Jev HTTP status 403: {"error":{"message":"Free tier users do not have access to this model.","type":"forbidden"}}' },
    });
    expect((await evaluateTenant(await org(), new Date())).opened).toBe(1);
    const alert = await prisma.alert.findFirstOrThrow({ where: { tenantId: tenant.id, kind: "jev_access_denied", status: "open" } });
    expect(alert.title).toBe("Jev is refusing requests (HTTP 403)");
    expect(alert.detail).toContain("Free tier users do not have access to this model.");

    const ok = await createReceivedEmail(tenant.id, mailboxConnection.id, "r2");
    await prisma.analysisResult.create({ data: { tenantId: tenant.id, emailId: ok.id, schemaVersion: "v1", jevModel: "jev", status: "ok", inputTokens: 1, outputTokens: 1, answers: {} } });
    await evaluateTenant(await org(), new Date());
    expect(await prisma.alert.count({ where: { tenantId: tenant.id, kind: "jev_access_denied", status: "open" } })).toBe(0);
  });
});

describe("reports (Phase 18)", () => {
  beforeEach(resetDatabase);

  it("counts emails, Jev verdicts, destinations and rule matches per day", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    await createRule(tenant.id, { name: "Marketing", priority: 1, conditions: MARKETING, destinationRef: "human_review" });
    const spam = await analyzedEmail(tenant.id, mailboxConnection.id, "1", defaultAnswers({ is_spam: { noul: 0.95 }, category: { choice: "marketing", probabilities: {}, confidence: 1 } }));
    const normal = await analyzedEmail(tenant.id, mailboxConnection.id, "2");
    await createReceivedEmail(tenant.id, mailboxConnection.id, "3"); // not analyzed
    for (const e of [spam, normal]) await evaluateRulesForEmail(e.id);

    const report = await buildReport({ tenantId: tenant.id, days: 7, timeZone: "Europe/Istanbul" });

    expect(report.totals).toMatchObject({ emails: 3, analyzed: 2, spam: 1, needsReply: 2 }); // defaultAnswers() says requires_response 0.8
    expect(report.daily.length).toBeGreaterThanOrEqual(7);
    expect(report.daily.at(-1)!.emails).toBe(3);
    expect(report.categories).toEqual(expect.arrayContaining([{ category: "marketing", count: 1 }, { category: "business_opportunity", count: 1 }]));
    expect(report.destinations).toEqual([{ destinationRef: "human_review", count: 2 }]);
    expect(report.rules).toEqual([expect.objectContaining({ name: "Marketing", matches: 1 })]);
    expect(report.senderAuth).toEqual({ checked: 0, verified: 0 });

    // Sender verdicts: counted only where the provider left one.
    await prisma.email.update({ where: { id: spam.id }, data: { senderAuthCaptured: true, senderAuth: { source: "authentication-results", spf: "fail", authenticated: false } } });
    await prisma.email.update({ where: { id: normal.id }, data: { senderAuthCaptured: true, senderAuth: { source: "authentication-results", spf: "pass", dmarc: "pass", authenticated: true } } });
    const withAuth = await buildReport({ tenantId: tenant.id, days: 7, timeZone: "Europe/Istanbul" });
    expect(withAuth.senderAuth).toEqual({ checked: 2, verified: 1 });
  });

  it("counts an edited rule once: its versions share a row under the newest name", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const v1 = await createRule(tenant.id, { name: "Marketing", priority: 1, conditions: MARKETING, destinationRef: "human_review" });
    const first = await analyzedEmail(tenant.id, mailboxConnection.id, "1", defaultAnswers({ category: { choice: "marketing", probabilities: {}, confidence: 1 } }));
    await evaluateRulesForEmail(first.id);
    await updateRule(v1.id, { name: "Marketing (new)", priority: 1, conditions: MARKETING, destinationRef: "human_review" });
    const second = await analyzedEmail(tenant.id, mailboxConnection.id, "2", defaultAnswers({ category: { choice: "marketing", probabilities: {}, confidence: 1 } }));
    await evaluateRulesForEmail(second.id);

    const report = await buildReport({ tenantId: tenant.id, days: 7, timeZone: "Europe/Istanbul" });
    expect(report.rules).toEqual([expect.objectContaining({ ruleId: v1.id, name: "Marketing (new)", matches: 2 })]);
  });
});
