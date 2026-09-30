import { loadEnv } from "../../../config/env.js";
import { assertSsrfSafeUrl, type DnsLookupFn } from "./ssrf.js";
import { performWebhookRequest, WebhookConnectionError, WebhookResponseLostError, WebhookTimeoutError, type WebhookHttpResult, type WebhookRequestInput } from "./webhookHttpClient.js";
import { classifyWebhookResponse } from "./webhookExecutor.js";
import type { ExecutionOutcome } from "./types.js";

/**
 * One JSON POST with the webhook channel's protections and outcome rules
 * (Phase 19, shared by the Slack, Teams, Jira and Zendesk channels): the URL
 * is SSRF-checked at send time and the connection pinned to the checked
 * address; 2xx succeeds, 408/429/5xx retry, other 4xx fail permanently; a
 * connection lost after sending is ambiguous (never resent blindly).
 */
export interface HttpPostDeps {
  dnsLookup?: DnsLookupFn;
  performRequest?: (input: WebhookRequestInput) => Promise<WebhookHttpResult>;
}

export async function postJson(input: { url: string; headers?: Record<string, string>; body: unknown; captureBody?: boolean }, deps: HttpPostDeps = {}): Promise<{ outcome: ExecutionOutcome; responseBody?: string }> {
  let target;
  try {
    target = await assertSsrfSafeUrl(input.url, deps.dnsLookup);
  } catch (error) {
    return { outcome: { status: "failed", retryable: false, errorClass: "ssrf_blocked", errorMessage: error instanceof Error ? error.message : String(error) } };
  }
  try {
    const result = await (deps.performRequest ?? performWebhookRequest)({
      url: input.url,
      address: target.address,
      family: target.family,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...input.headers },
      body: JSON.stringify(input.body),
      timeoutMs: loadEnv().WEBHOOK_TIMEOUT_MS,
      captureBody: input.captureBody,
    });
    return { outcome: classifyWebhookResponse(result.statusCode), responseBody: result.body };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof WebhookResponseLostError) return { outcome: { status: "ambiguous", errorMessage: message } };
    if (error instanceof WebhookTimeoutError || error instanceof WebhookConnectionError) return { outcome: { status: "failed", retryable: true, errorClass: "connection", errorMessage: message } };
    return { outcome: { status: "failed", retryable: true, errorClass: "connection", errorMessage: message } };
  }
}
