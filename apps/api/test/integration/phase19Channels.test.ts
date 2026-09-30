import { beforeEach, describe, expect, it } from "vitest";
import type Mail from "nodemailer/lib/mailer/index.js";
import { prisma } from "../../src/db/client.js";
import { updateSystemSettings } from "../../src/modules/settings/systemSettings.js";
import { createAutoReplyExecutor, NO_REPLY_LOCAL_PART } from "../../src/modules/destinations/executors/autoReplyExecutor.js";
import { createChatExecutor } from "../../src/modules/destinations/executors/chatExecutor.js";
import { createJiraExecutor, createZendeskExecutor } from "../../src/modules/destinations/executors/ticketExecutor.js";
import { WebhookResponseLostError, type WebhookRequestInput } from "../../src/modules/destinations/executors/webhookHttpClient.js";
import { slackEscape } from "../../src/modules/destinations/executors/integrationMessage.js";
import { persistNormalizedEmail } from "../../src/modules/ingestion/persist.js";
import { parseImapMessage } from "../../src/modules/mail-providers/imap/parse.js";
import type { ExecutionContext } from "../../src/modules/destinations/executors/types.js";
import type { ForwardSender } from "../../src/modules/destinations/executors/forwardExecutor.js";
import { createReceivedEmail, createTestTenantAndMailbox, resetDatabase } from "../helpers/db.js";

const PUBLIC = async () => [{ address: "93.184.216.34", family: 4 }];

async function setup(type: string, config: Record<string, unknown>, emailOverrides: Record<string, unknown> = {}, signals: Record<string, unknown> = { is_spam: { noul: 0.05 }, category: { choice: "job_offer" } }) {
  const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
  await updateSystemSettings({ smtpHost: "smtp.test.invalid", smtpFromAddress: "hr@acme.test", appBaseUrl: "https://jev.acme.test" }, "admin");
  const email = await createReceivedEmail(tenant.id, mailboxConnection.id, "1", { subject: "Application <Ayşe>", fromAddress: "ayse@candidate.test" });
  await prisma.email.update({ where: { id: email.id }, data: { headersCaptured: true, messageId: "<m1@candidate.test>", senderName: "Ayşe", ...emailOverrides } });
  const destination = await prisma.destination.create({ data: { tenantId: tenant.id, name: "Careers" } });
  const channel = await prisma.destinationChannel.create({ data: { tenantId: tenant.id, destinationId: destination.id, type, config: config as never as object, version: 1 } });
  const ctx: ExecutionContext = {
    tenantId: tenant.id,
    email: { id: email.id, mailboxConnectionId: mailboxConnection.id, externalId: "1", uidValidity: 1, subject: "Application <Ayşe>", fromAddress: "ayse@candidate.test", toAddresses: [] },
    routing: { destinationRef: "Careers" },
    analysis: { signals },
    channel: { id: channel.id, type, config, destinationId: destination.id },
    idempotencyKey: `${email.id}:d:${channel.id}`,
  };
  return { tenant, email, destination, ctx };
}

function capture() {
  const sent: Mail.Options[] = [];
  const sender: ForwardSender = async (m) => {
    sent.push(m);
    return { messageId: "<id>", accepted: [String(m.to)], rejected: [] };
  };
  return { sent, sender };
}

const REPLY = { body: "Hello {sender_name}, thanks for applying. We read every application.", subjectTemplate: "Re: {subject}" };

describe("auto-reply (Phase 19)", () => {
  beforeEach(resetDatabase);

  it("answers a person once, threaded, marked auto-replied — and not again within the cooldown", async () => {
    const { ctx } = await setup("auto_reply", REPLY);
    const { sent, sender } = capture();

    expect(await createAutoReplyExecutor(sender).execute(ctx)).toMatchObject({ status: "succeeded", responseMetadata: { sent: true, recipient: "ayse@candidate.test" } });
    expect(sent[0]).toMatchObject({ to: "ayse@candidate.test", subject: "Re: Application <Ayşe>", inReplyTo: "<m1@candidate.test>", headers: { "Auto-Submitted": "auto-replied" } });
    expect(sent[0]!.text).toBe("Hello Ayşe, thanks for applying. We read every application.");
    expect(String(sent[0]!.html)).not.toContain("<Ayşe>");

    expect(await createAutoReplyExecutor(sender).execute({ ...ctx, idempotencyKey: "other" })).toMatchObject({ status: "succeeded", responseMetadata: { sent: false, skipped: "cooldown" } });
    expect(sent).toHaveLength(1);
  });

  it.each([
    [{ autoSubmitted: "auto-generated" }, "automated"],
    [{ precedence: "bulk" }, "automated"],
    [{ listId: "<news.shop.test>" }, "mailing_list"],
    [{ fromAddress: "no-reply@shop.test" }, "no_reply_address"],
    [{ headersCaptured: false }, "headers_unknown"],
    [{ forwardedByEumaeus: true }, "own_mail"],
  ])("stays silent for %j (%s)", async (overrides, reason) => {
    const { ctx } = await setup("auto_reply", REPLY, overrides);
    const { sent, sender } = capture();
    expect(await createAutoReplyExecutor(sender).execute(ctx)).toMatchObject({ status: "succeeded", responseMetadata: { sent: false, skipped: reason } });
    expect(sent).toHaveLength(0);
  });

  it("stays silent for likely spam and unanalyzed mail; answers Reply-To when set", async () => {
    const spam = await setup("auto_reply", REPLY, {}, { is_spam: { noul: 0.9 } });
    expect((await createAutoReplyExecutor(capture().sender).execute(spam.ctx)).status).toBe("succeeded");
    expect(await createAutoReplyExecutor(capture().sender).execute(spam.ctx)).toMatchObject({ responseMetadata: { skipped: "likely_spam" } });

    await resetDatabase();
    const { ctx } = await setup("auto_reply", REPLY, { replyToAddress: "Jobs@Candidate.test" });
    const { sent, sender } = capture();
    await createAutoReplyExecutor(sender).execute(ctx);
    expect(sent[0]!.to).toBe("jobs@candidate.test");
    expect(await createAutoReplyExecutor(capture().sender).execute({ ...ctx, analysis: undefined, idempotencyKey: "x" })).toMatchObject({ responseMetadata: { skipped: "no_analysis" } });
  });

  it("recognizes no-reply style addresses", () => {
    for (const local of ["noreply", "no-reply", "do-not-reply", "donotreply", "mailer-daemon", "postmaster", "bounces+123", "no_reply.alerts"]) expect(NO_REPLY_LOCAL_PART.test(local)).toBe(true);
    for (const local of ["ayse", "replyto", "norah", "info"]) expect(NO_REPLY_LOCAL_PART.test(local)).toBe(false);
  });

  it("ingestion captures the headers auto-reply depends on", async () => {
    const { tenant, mailboxConnection } = await createTestTenantAndMailbox();
    const raw = Buffer.from(
      ["From: Shop News <news@shop.test>", "To: bob@eumaeus.test", "Reply-To: help@shop.test", "Subject: Sale", "List-Id: <news.shop.test>", "Precedence: bulk", "Auto-Submitted: auto-generated", "Message-ID: <n1@shop.test>", "", "hi", ""].join("\r\n"),
    );
    const { email } = await persistNormalizedEmail(tenant.id, mailboxConnection.id, await parseImapMessage({ uid: 9, uidValidity: 1, source: raw }));
    expect(email).toMatchObject({ headersCaptured: true, listId: "<news.shop.test>", precedence: "bulk", autoSubmitted: "auto-generated", replyToAddress: "help@shop.test", senderName: "Shop News" });
  });
});

describe("Slack, Teams, Jira, Zendesk (Phase 19)", () => {
  beforeEach(resetDatabase);

  function fakeHttp(status: number, body = "") {
    const requests: WebhookRequestInput[] = [];
    return { requests, deps: { dnsLookup: PUBLIC, performRequest: async (input: WebhookRequestInput) => (requests.push(input), { statusCode: status, body }) } };
  }

  it("Slack: a formatted message where the email can't @mention the channel", async () => {
    const { ctx } = await setup("slack", { url: "https://hooks.slack.test/services/T/B/X" });
    const http = fakeHttp(200);
    expect((await createChatExecutor("slack", http.deps).execute({ ...ctx, email: { ...ctx.email, subject: "<!channel> urgent" } })).status).toBe("succeeded");
    const payload = JSON.parse(http.requests[0]!.body);
    expect(JSON.stringify(payload)).not.toContain("<!channel>");
    expect(payload.blocks[0].text.text).toContain("&lt;!channel&gt; urgent");
    expect(payload.blocks[1].elements[0].text).toContain("<https://jev.acme.test/emails/");
    expect(slackEscape("a & <b>")).toBe("a &amp; &lt;b&gt;");
  });

  it("Teams: an Adaptive Card with a link back", async () => {
    const { ctx } = await setup("teams", { url: "https://acme.webhook.office.test/x" });
    const http = fakeHttp(202);
    expect((await createChatExecutor("teams", http.deps).execute(ctx)).status).toBe("succeeded");
    const card = JSON.parse(http.requests[0]!.body).attachments[0].content;
    expect(card.type).toBe("AdaptiveCard");
    expect(card.actions[0].url).toMatch(/^https:\/\/jev\.acme\.test\/emails\//);
  });

  it("Jira: opens an issue with basic auth and records its key and link", async () => {
    const { ctx } = await setup("jira", { baseUrl: "https://acme.atlassian.test", projectKey: "SUP", issueType: "Task", accountEmail: "bot@acme.test", secretName: "jira" });
    const http = fakeHttp(201, JSON.stringify({ id: "10001", key: "SUP-42" }));
    const outcome = await createJiraExecutor({ ...http.deps, resolveSecret: async () => "tok" }).execute(ctx);
    expect(outcome).toMatchObject({ status: "succeeded", responseMetadata: { issueKey: "SUP-42", url: "https://acme.atlassian.test/browse/SUP-42" } });
    expect(http.requests[0]!.url).toBe("https://acme.atlassian.test/rest/api/3/issue");
    expect(http.requests[0]!.headers.Authorization).toBe(`Basic ${Buffer.from("bot@acme.test:tok").toString("base64")}`);
    expect(JSON.parse(http.requests[0]!.body).fields).toMatchObject({ project: { key: "SUP" }, summary: "Application <Ayşe>" });
  });

  it("Zendesk: opens a ticket with API-token auth; a bad token fails permanently; a lost response is ambiguous", async () => {
    const { ctx } = await setup("zendesk", { subdomain: "acme", accountEmail: "bot@acme.test", secretName: "zd", priority: "high" });
    const ok = fakeHttp(201, JSON.stringify({ ticket: { id: 77 } }));
    expect(await createZendeskExecutor({ ...ok.deps, resolveSecret: async () => "tok" }).execute(ctx)).toMatchObject({ status: "succeeded", responseMetadata: { ticketId: 77, url: "https://acme.zendesk.com/agent/tickets/77" } });
    expect(ok.requests[0]!.headers.Authorization).toBe(`Basic ${Buffer.from("bot@acme.test/token:tok").toString("base64")}`);

    const denied = fakeHttp(401);
    expect(await createZendeskExecutor({ ...denied.deps, resolveSecret: async () => "bad" }).execute(ctx)).toMatchObject({ status: "failed", retryable: false });

    const lost = { dnsLookup: PUBLIC, performRequest: async () => Promise.reject(new WebhookResponseLostError("socket hang up")), resolveSecret: async () => "tok" };
    expect((await createZendeskExecutor(lost).execute(ctx)).status).toBe("ambiguous");
  });

  it("a missing API token secret is a clear configuration error; a private address is refused", async () => {
    const { ctx } = await setup("jira", { baseUrl: "https://acme.atlassian.test", projectKey: "SUP", issueType: "Task", accountEmail: "bot@acme.test", secretName: "missing" });
    expect(await createJiraExecutor({ dnsLookup: PUBLIC }).execute(ctx)).toMatchObject({ status: "failed", retryable: false, errorClass: "invalid_config" });

    const chat = await setup("slack", { url: "https://internal.test/hook" });
    const outcome = await createChatExecutor("slack", { dnsLookup: async () => [{ address: "10.0.0.5", family: 4 }] }).execute(chat.ctx);
    expect(outcome).toMatchObject({ status: "failed", errorClass: "ssrf_blocked" });
  });
});
