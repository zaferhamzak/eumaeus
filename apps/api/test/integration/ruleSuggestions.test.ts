import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { refreshRuleSuggestions, listRuleSuggestions, acceptRuleSuggestion, dismissRuleSuggestion, subjectWords } from "../../src/modules/review/ruleSuggestions.js";
import { refreshSuggestions } from "../../src/modules/review/suggestions.js";
import { escalateToHumanReview } from "../../src/modules/review/escalate.js";
import { resolveReviewItem } from "../../src/modules/review/resolveReview.js";
import { createReceivedEmail, createSuccessfulAnalysis, createTestTenantAndMailbox, defaultAnswers, resetDatabase } from "../helpers/db.js";

async function decided(tenantId: string, mailboxId: string, uid: string, subject: string, resolution: "spam" | "approved" | null, category = "support") {
  const e = await createReceivedEmail(tenantId, mailboxId, uid, { fromAddress: "security@mail.instagram.com", subject });
  await createSuccessfulAnalysis(tenantId, e.id, defaultAnswers({ category: { choice: category, probabilities: {}, confidence: 0.9 } }));
  await escalateToHumanReview(tenantId, e.id, { errorMessage: "x", attemptsMade: 0, reason: "unmatched" });
  const item = await prisma.humanReviewItem.findFirstOrThrow({ where: { emailId: e.id } });
  if (resolution) await resolveReviewItem(tenantId, item.id, resolution);
  else await prisma.humanReviewItem.update({ where: { id: item.id }, data: { status: "superseded", resolvedAt: new Date() } });
  return e;
}

describe("rule suggestions by subject (Phase 5 of the fix plan)", () => {
  beforeEach(resetDatabase);

  it("reduces subjects to meaningful words", () => {
    expect(subjectWords("ornekhesap_istanbul, sizi takip etmek isteyen 3 kişi var")).toEqual(["takip", "isteyen", "kişi"]);
    expect(subjectWords("Reset your password for a@b.com")).toEqual(["reset", "password"]);
  });

  it("splits one sender into a security group and a follow-request group, from people's decisions only", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const t = tenant.id;
    const m = mailboxConnection.id;
    await prisma.destination.create({ data: { tenantId: t, name: "Junk" } });
    for (let i = 0; i < 4; i += 1) await decided(t, m, `p${i}`, `Reset your password ${i}`, "approved", "support");
    for (let i = 0; i < 4; i += 1) await decided(t, m, `f${i}`, `ornekhesap_istanbul, sizi takip etmek isteyen ${i} kişi`, "spam", "marketing");
    // Reprocessing closures are not evidence.
    for (let i = 0; i < 6; i += 1) await decided(t, m, `s${i}`, "New login to Instagram", null);

    // A whole-sender suggestion would be wrong here: 4 approved vs 4 spam is no agreement.
    expect(await refreshSuggestions(t)).toEqual([]);

    const open = await refreshRuleSuggestions(t);
    expect(open.map((s) => s.pattern).sort()).toEqual(["rule:mail.instagram.com:isteyen:spam", "rule:mail.instagram.com:password:approved"]);

    const views = await listRuleSuggestions(t);
    const follow = views.find((v) => v.decision === "spam")!;
    expect(follow.draft).toMatchObject({
      destinationRef: "Junk",
      affected: 4,
      conditions: { op: "AND", children: [{ field: "sender.domain", op: "==", value: "mail.instagram.com" }, { field: "subject", op: "contains", value: "isteyen" }, { field: "answers.category", op: "==", value: "marketing" }] },
    });
    const security = views.find((v) => v.decision === "approved")!;
    expect(security.draft.destinationRef).toBeNull(); // nowhere to infer from — the person chooses
    await expect(acceptRuleSuggestion(t, security.suggestion.id, "admin")).rejects.toThrow(/Choose where/);

    const accepted = await acceptRuleSuggestion(t, follow.suggestion.id, "admin");
    const rule = await prisma.rule.findUniqueOrThrow({ where: { id: accepted.ruleId } });
    expect(rule).toMatchObject({ destinationRef: "Junk", deactivatedAt: null });
    expect((await acceptRuleSuggestion(t, security.suggestion.id, "admin", { destinationRef: "Guvenlik" })).suggestion.status).toBe("accepted");

    // Accepted ones aren't suggested again; a dismissed one stays quiet.
    expect(await refreshRuleSuggestions(t)).toEqual([]);
  });

  it("dismissing keeps a suggestion from coming back; sender suggestions are unaffected by rule suggestions", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    for (let i = 0; i < 3; i += 1) await decided(tenant.id, mailboxConnection.id, `x${i}`, `Weekly digest ${i}`, "spam", "marketing");
    const [s] = await refreshRuleSuggestions(tenant.id);
    await dismissRuleSuggestion(tenant.id, s!.id, "admin");
    expect(await refreshRuleSuggestions(tenant.id)).toEqual([]);
    expect(await prisma.routingSuggestion.count({ where: { tenantId: tenant.id, kind: "rule", status: "dismissed" } })).toBe(1);
    // refreshSuggestions (sender level) must not delete the rule suggestion rows.
    await refreshSuggestions(tenant.id);
    expect(await prisma.routingSuggestion.count({ where: { tenantId: tenant.id, kind: "rule" } })).toBe(1);
  });
});
