import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db/client.js";
import { jevStatus } from "../../src/modules/jev/status.js";
import { createReceivedEmail, createSuccessfulAnalysis, createTestTenantAndMailbox, defaultAnswers, resetDatabase } from "../helpers/db.js";
import { buildTestServer } from "../api/helpers/buildTestServer.js";

async function failedAnalysis(tenantId: string, emailId: string, message: string, at: Date) {
  return prisma.analysisResult.create({ data: { tenantId, emailId, schemaVersion: "v1", jevModel: "jev-1.13.0", status: "error", errorClass: "authentication", errorMessage: message, createdAt: at } });
}

/** 1.2 (G): Jev's state for an organization, and the emails it left unanalyzed. */
describe("Jev status", () => {
  beforeEach(resetDatabase);

  it("reports a current refusal, the emails left behind (only while their latest analysis failed) and the week's volume", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const now = new Date();
    const ok = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
    await createSuccessfulAnalysis(tenant.id, ok.id, defaultAnswers());
    const refused = await createReceivedEmail(tenant.id, mailboxConnection.id, "2");
    await failedAnalysis(tenant.id, refused.id, 'Unexpected Jev HTTP status 403: {"error":{"message":"Free tier users do not have access to this model."}}', new Date(now.getTime() + 1000));
    const recovered = await createReceivedEmail(tenant.id, mailboxConnection.id, "3");
    await failedAnalysis(tenant.id, recovered.id, "timeout", new Date(now.getTime() - 60_000));
    await createSuccessfulAnalysis(tenant.id, recovered.id, defaultAnswers());
    const stuck = await createReceivedEmail(tenant.id, mailboxConnection.id, "4");
    await prisma.email.update({ where: { id: stuck.id }, data: { ingestedAt: new Date(now.getTime() - 10 * 60_000) } });

    const status = await jevStatus(tenant.id, new Date(now.getTime() + 2000));
    expect(status.accessDenied).toBe(true);
    expect(status.currentError).toEqual({ httpStatus: 403, message: "Free tier users do not have access to this model." });
    expect(status.failed).toBe(1);
    expect(status.failedEmailIds).toEqual([refused.id]);
    // All four are still "received" (the helper doesn't advance state), but only the stuck one is past the 2-minute grace.
    expect(status.waiting).toBe(1);
    expect(status.last7Days).toMatchObject({ ok: 2, error: 2 });
  });

  it("a success after the error clears the current error", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const e = await createReceivedEmail(tenant.id, mailboxConnection.id, "1");
    await failedAnalysis(tenant.id, e.id, "Unexpected Jev HTTP status 500: oops", new Date(Date.now() - 60_000));
    const f = await createReceivedEmail(tenant.id, mailboxConnection.id, "2");
    await createSuccessfulAnalysis(tenant.id, f.id, defaultAnswers());
    const status = await jevStatus(tenant.id);
    expect(status.currentError).toBeNull();
    expect(status.accessDenied).toBe(false);
    expect(status.failed).toBe(1);
  });

  it("API: GET /api/v1/jev/status", async () => {
    const { tenant } = await createTestTenantAndMailbox();
    const res = await buildTestServer(tenant.id).inject({ method: "GET", url: "/api/v1/jev/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ lastSuccessAt: null, failed: 0, accessDenied: false });
  });
});
