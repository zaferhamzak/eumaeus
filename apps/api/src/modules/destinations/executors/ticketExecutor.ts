import { prisma } from "../../../db/client.js";
import { getSystemSettings } from "../../settings/systemSettings.js";
import { DestinationSecretError, resolveDestinationSecretPlaintext } from "../manageSecrets.js";
import type { JiraChannelConfig, ZendeskChannelConfig } from "../types.js";
import { postJson, type HttpPostDeps } from "./httpPost.js";
import { summarize, ticketText } from "./integrationMessage.js";
import type { DestinationExecutor, ExecutionContext, ExecutionOutcome } from "./types.js";

/**
 * Phase 19: opens a Jira issue or a Zendesk ticket for the email. The API
 * token is a destination secret (encrypted, never returned). The created
 * issue's key / ticket id and its link are recorded on the execution.
 *
 * Creating an issue is not idempotent on their side: a connection lost after
 * the request was sent is "ambiguous" and never retried automatically, so a
 * glitch can't open the same ticket twice.
 */
export interface TicketDeps extends HttpPostDeps {
  resolveSecret?: (tenantId: string, destinationId: string, name: string) => Promise<string>;
}

async function secretFor(ctx: ExecutionContext, name: string, deps: TicketDeps): Promise<string | ExecutionOutcome> {
  try {
    return await (deps.resolveSecret ?? resolveDestinationSecretPlaintext)(ctx.tenantId, ctx.channel.destinationId, name);
  } catch (error) {
    return { status: "failed", retryable: false, errorClass: "invalid_config", errorMessage: error instanceof DestinationSecretError ? error.message : `The API token secret "${name}" could not be read` };
  }
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

function parse(body: string | undefined): Record<string, unknown> {
  try {
    return JSON.parse(body ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function context(ctx: ExecutionContext) {
  const [settings, email] = await Promise.all([getSystemSettings(), prisma.email.findUnique({ where: { id: ctx.email.id }, select: { receivedAt: true, textBody: true } })]);
  const summary = summarize(ctx, settings.appBaseUrl);
  return { summary, text: ticketText(summary, email?.receivedAt ?? new Date(), email?.textBody ?? null) };
}

export function createJiraExecutor(deps: TicketDeps = {}): DestinationExecutor {
  return {
    channelType: "jira",
    execute: async (ctx) => {
      const config = ctx.channel.config as JiraChannelConfig;
      const token = await secretFor(ctx, config.secretName, deps);
      if (typeof token !== "string") return token;
      const { summary, text } = await context(ctx);
      const { outcome, responseBody } = await postJson(
        {
          url: `${config.baseUrl}/rest/api/3/issue`,
          headers: { Authorization: basic(config.accountEmail, token) },
          captureBody: true,
          body: {
            fields: {
              project: { key: config.projectKey },
              issuetype: { name: config.issueType },
              summary: summary.subject.slice(0, 250),
              labels: ["eumaeus"],
              // Atlassian Document Format: one paragraph per line, plain text only.
              description: { type: "doc", version: 1, content: text.split("\n").map((line) => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] })) },
            },
          },
        },
        deps,
      );
      if (outcome.status !== "succeeded") return outcome;
      const key = parse(responseBody).key;
      return { status: "succeeded", responseMetadata: { ...outcome.responseMetadata, ...(typeof key === "string" ? { issueKey: key, url: `${config.baseUrl}/browse/${key}` } : {}) } };
    },
  };
}

export function createZendeskExecutor(deps: TicketDeps = {}): DestinationExecutor {
  return {
    channelType: "zendesk",
    execute: async (ctx) => {
      const config = ctx.channel.config as ZendeskChannelConfig;
      const token = await secretFor(ctx, config.secretName, deps);
      if (typeof token !== "string") return token;
      const { summary, text } = await context(ctx);
      const base = `https://${config.subdomain}.zendesk.com`;
      const { outcome, responseBody } = await postJson(
        {
          url: `${base}/api/v2/tickets.json`,
          // Zendesk API-token auth: "{email}/token:{api_token}".
          headers: { Authorization: basic(`${config.accountEmail}/token`, token) },
          captureBody: true,
          body: { ticket: { subject: summary.subject, comment: { body: text }, tags: ["eumaeus"], ...(config.priority ? { priority: config.priority } : {}) } },
        },
        deps,
      );
      if (outcome.status !== "succeeded") return outcome;
      const id = (parse(responseBody).ticket as { id?: unknown } | undefined)?.id;
      return { status: "succeeded", responseMetadata: { ...outcome.responseMetadata, ...(typeof id === "number" ? { ticketId: id, url: `${base}/agent/tickets/${id}` } : {}) } };
    },
  };
}

export const jiraExecutor = createJiraExecutor();
export const zendeskExecutor = createZendeskExecutor();
