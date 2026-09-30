import { prisma } from "../../src/db/client.js";
import { EmailState } from "../../src/types/email-state.js";
import { setMailboxCredential } from "../../src/modules/mail-providers/imap/mailboxCredentials.js";
import { clearSystemSettingsCache } from "../../src/modules/settings/systemSettings.js";
import { getSessionRedis } from "../../src/modules/auth/sessionStore.js";

/** Deletes all rows, in FK-safe order, between tests. Test DB only — see test/setup.ts. */
export async function resetDatabase(): Promise<void> {
  // Phase 11: Membership references both User and Tenant, AuthEvent
  // references User — both must go before tenant.deleteMany()/user.deleteMany() below.
  await prisma.membership.deleteMany();
  await prisma.apiKey.deleteMany();
  await prisma.tenantQuestion.deleteMany();
  await prisma.authEvent.deleteMany();
  await prisma.forwardDigestItem.deleteMany();
  await prisma.notifyQueueItem.deleteMany();
  await prisma.notifyChannelState.deleteMany();
  await prisma.forwardDigestBatch.deleteMany();
  await prisma.actionExecution.deleteMany();
  await prisma.destinationSecret.deleteMany();
  await prisma.destinationChannel.deleteMany();
  await prisma.destination.deleteMany();
  await prisma.routingDecision.deleteMany();
  await prisma.ruleEvaluation.deleteMany();
  await prisma.rule.deleteMany();
  await prisma.ruleNode.deleteMany();
  await prisma.ruleGraphVersion.deleteMany();
  await prisma.ruleGraph.deleteMany();
  await prisma.analysisResult.deleteMany();
  await prisma.humanReviewItem.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.ingestionSuppression.deleteMany();
  await prisma.emailSource.deleteMany();
  await prisma.email.deleteMany();
  // Must precede mailboxConnection.deleteMany() — MailboxCredential's FK to
  // MailboxConnection is ON DELETE RESTRICT (unlike RuleGraph's ON DELETE SET
  // NULL relation to it), so a leftover credential row would block the delete.
  await prisma.mailboxCredential.deleteMany();
  await prisma.mailboxOAuthToken.deleteMany();
  await prisma.mailboxConnection.deleteMany();
  await prisma.forwardRecipient.deleteMany();
  await prisma.senderListEntry.deleteMany();
  await prisma.alert.deleteMany();
  await prisma.outboundEmail.deleteMany();
  await prisma.autoReplyRecord.deleteMany();
  await prisma.routingSuggestion.deleteMany();
  await prisma.tenant.deleteMany();
  await prisma.user.deleteMany();
  await prisma.systemSettings.deleteMany();
  // The row above is gone, but modules/settings/systemSettings.ts's
  // in-process cache (30s TTL, deliberately not query-per-request) would
  // otherwise still return the just-deleted row's stale object to whichever
  // test runs next in this same file/worker.
  clearSystemSettingsCache();
  // Login-lockout counters live in Redis, not the DB, and would otherwise
  // accumulate across test runs (a test that deliberately fails one login per
  // run would lock its own fixture email after five runs).
  const redis = getSessionRedis();
  const lockoutKeys = await redis.keys("auth_fail:*");
  if (lockoutKeys.length > 0) await redis.del(...lockoutKeys);
}

/** Includes a real MailboxCredential row (Phase 10) — syncMailbox() now requires one to exist for any mailbox it's asked to sync, exactly like a real mailbox created through the API. */
export async function createTestTenantAndMailbox() {
  const tenant = await prisma.tenant.create({ data: { name: "Test Tenant" } });
  const mailboxConnection = await prisma.mailboxConnection.create({
    data: {
      tenantId: tenant.id,
      name: "Test Mailbox",
      provider: "imap",
      emailAddress: "bob@eumaeus.test",
      providerConfig: { host: "imap.test.invalid", port: 993, tls: true, folder: "INBOX", username: "bob" },
      status: "active",
    },
  });
  await setMailboxCredential(tenant.id, mailboxConnection.id, "test-password-not-real");
  return { tenant, mailboxConnection };
}

export interface ReceivedEmailOverrides {
  subject?: string;
  textBody?: string;
  fromAddress?: string;
  hasAttachments?: boolean;
  attachmentMeta?: Array<{ filename: string; contentType: string; size: number }>;
  uidValidity?: number;
}

export async function createReceivedEmail(
  tenantId: string,
  mailboxConnectionId: string,
  externalId: string,
  overrides: ReceivedEmailOverrides = {},
) {
  const now = new Date();
  return prisma.email.create({
    data: {
      tenantId,
      mailboxConnectionId,
      provider: "imap",
      externalId,
      uidValidity: overrides.uidValidity ?? 1,
      fromAddress: overrides.fromAddress ?? "alice@example.com",
      toAddresses: ["bob@eumaeus.test"],
      ccAddresses: [],
      bccAddresses: [],
      subject: overrides.subject ?? "Test",
      textBody: overrides.textBody,
      receivedAt: now,
      hasAttachments: overrides.hasAttachments ?? false,
      attachmentMeta: overrides.attachmentMeta,
      state: EmailState.RECEIVED,
      stateUpdatedAt: now,
      ingestedAt: now,
    },
  });
}

/** Creates a successful AnalysisResult directly — used by Rule Engine tests, which start from "analysis already happened" rather than re-driving the whole Jev pipeline. */
export async function createSuccessfulAnalysis(
  tenantId: string,
  emailId: string,
  answers: Record<string, unknown>,
) {
  return prisma.analysisResult.create({
    data: {
      tenantId,
      emailId,
      schemaVersion: "v1",
      jevModel: "jev-1.13.0",
      answers: answers as never as object,
      status: "ok",
      inputTokens: 100,
      outputTokens: 0,
    },
  });
}

/** A complete, valid Decision Schema v1 answer set with sensible neutral defaults — override individual signals per test. */
export function defaultAnswers(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    is_spam: { noul: 0.02 },
    category: { choice: "business_opportunity", probabilities: { business_opportunity: 1 }, confidence: 0.9 },
    is_business_opportunity: { noul: 0.9 },
    is_collaboration: { noul: 0.1 },
    is_customer_related: { noul: 0.1 },
    requires_response: { noul: 0.8 },
    urgency: { score: 1, legend: { "0": "low", "1": "medium", "2": "high", "3": "critical" }, probabilities: { "0": 0.2, "1": 0.6, "2": 0.2, "3": 0 }, confidence: 0.6 },
    human_review_required: { noul: 0.05 },
    ...overrides,
  };
}

/** Creates a Destination with one enabled "archive" channel — the standard Phase 5A test fixture. */
export async function createArchiveDestination(tenantId: string, name: string, folder = "Archive") {
  const destination = await prisma.destination.create({ data: { tenantId, name } });
  const channel = await prisma.destinationChannel.create({
    data: { tenantId, destinationId: destination.id, type: "archive", config: { folder }, enabled: true, version: 1 },
  });
  return { destination, channel };
}

/** Creates a Destination with one enabled "webhook" channel — the standard Phase 5B test fixture. */
export async function createWebhookDestination(tenantId: string, name: string, url: string, secretName?: string) {
  const destination = await prisma.destination.create({ data: { tenantId, name } });
  const channel = await prisma.destinationChannel.create({
    data: {
      tenantId,
      destinationId: destination.id,
      type: "webhook",
      config: secretName ? { url, secretName } : { url },
      enabled: true,
      version: 1,
    },
  });
  return { destination, channel };
}

/** Directly inserts a "matched" RoutingDecision — used by destinations tests, which start from "the Rule Engine already decided" rather than re-driving Phase 4. */
export async function createMatchedRoutingDecision(
  tenantId: string,
  emailId: string,
  destinationRef: string,
  analysisResultId?: string,
) {
  return prisma.routingDecision.create({
    data: { tenantId, emailId, status: "matched", destinationRef, analysisResultId },
  });
}
