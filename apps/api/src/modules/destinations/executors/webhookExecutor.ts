import { loadEnv } from "../../../config/env.js";
import type { WebhookChannelConfig } from "../types.js";
import { resolveDestinationSecretPlaintext, DestinationSecretError } from "../manageSecrets.js";
import type { DestinationExecutor, ExecutionContext, ExecutionOutcome } from "./types.js";
import { assertSsrfSafeUrl, type DnsLookupFn } from "./ssrf.js";
import {
  performWebhookRequest,
  WebhookConnectionError,
  WebhookTimeoutError,
  WebhookResponseLostError,
  type WebhookRequestInput,
  type WebhookHttpResult,
} from "./webhookHttpClient.js";
import { signWebhookBody, WEBHOOK_SIGNATURE_HEADER, WEBHOOK_IDEMPOTENCY_HEADER } from "./webhookSignature.js";
import { buildWebhookPayload } from "./webhookPayload.js";
import { metrics } from "../../../metrics/metrics.js";
import { MetricName } from "../../../metrics/names.js";

/**
 * Injectable dependencies — mirrors ArchiveClientFactory's exact purpose
 * (archiveExecutor.ts): production code (DEFAULT_EXECUTORS in executeAction.ts)
 * calls createWebhookExecutor() with no arguments; tests inject fakes for DNS
 * resolution, the HTTP transport, and secret resolution so no test ever makes a
 * real network call or depends on a real encrypted secret round trip.
 */
export interface WebhookExecutorDeps {
  dnsLookup?: DnsLookupFn;
  performRequest?: (input: WebhookRequestInput) => Promise<WebhookHttpResult>;
  resolveSecret?: (tenantId: string, destinationId: string, name: string) => Promise<string>;
}

export function createWebhookExecutor(deps: WebhookExecutorDeps = {}): DestinationExecutor {
  return {
    channelType: "webhook",
    execute: (ctx: ExecutionContext) => executeWebhook(ctx, deps),
  };
}

/** Default instance for production wiring (DEFAULT_EXECUTORS in executeAction.ts). */
export const webhookExecutor: DestinationExecutor = createWebhookExecutor();

async function executeWebhook(ctx: ExecutionContext, deps: WebhookExecutorDeps): Promise<ExecutionOutcome> {
  const config = ctx.channel.config as WebhookChannelConfig;

  // SSRF check happens before anything else, and BEFORE the secret is ever
  // resolved — no reason to decrypt a secret for a request that will never be
  // sent. Any failure here (malformed URL, unsupported protocol, blocked
  // address, or the DNS lookup itself failing) is treated as a permanent
  // configuration problem: never silently retried, since none of these fix
  // themselves without a human correcting the destination's configured URL.
  let target;
  try {
    target = await assertSsrfSafeUrl(config.url, deps.dnsLookup);
  } catch (error) {
    return {
      status: "failed",
      retryable: false,
      errorClass: "ssrf_blocked",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  let secret: string | undefined;
  if (config.secretName) {
    const resolveSecret = deps.resolveSecret ?? resolveDestinationSecretPlaintext;
    try {
      secret = await resolveSecret(ctx.tenantId, ctx.channel.destinationId, config.secretName);
    } catch (error) {
      return {
        status: "failed",
        retryable: false,
        errorClass: "invalid_config",
        errorMessage: error instanceof DestinationSecretError ? error.message : "webhook secret could not be resolved",
      };
    }
  }

  const payload = buildWebhookPayload(ctx);
  const body = JSON.stringify(payload);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [WEBHOOK_IDEMPOTENCY_HEADER]: ctx.idempotencyKey,
  };
  if (secret) {
    // The secret signs the body and is placed in a header — never in the URL
    // (query string or path), never in the JSON payload itself, and never
    // logged. `secret` goes out of scope when this function returns; it is not
    // assigned anywhere else.
    headers[WEBHOOK_SIGNATURE_HEADER] = signWebhookBody(secret, body);
  }

  const performRequest = deps.performRequest ?? performWebhookRequest;
  const timeoutMs = loadEnv().WEBHOOK_TIMEOUT_MS;

  try {
    const result = await performRequest({
      url: config.url,
      address: target.address,
      family: target.family,
      headers,
      body,
      timeoutMs,
    });
    metrics.increment(MetricName.WEBHOOK_REQUEST);
    const outcome = classifyWebhookResponse(result.statusCode);
    metrics.increment(MetricName.WEBHOOK_OUTCOME, { outcome: webhookOutcomeLabel(outcome) });
    return outcome;
  } catch (error) {
    metrics.increment(MetricName.WEBHOOK_REQUEST);
    if (error instanceof WebhookResponseLostError) {
      // The request was fully sent (or the failure happened only after it was)
      // before any response arrived — the remote side may have already acted on
      // it. Never blindly retried; see idempotency.ts's skip_ambiguous handling.
      metrics.increment(MetricName.WEBHOOK_OUTCOME, { outcome: "response_lost" });
      return { status: "ambiguous", errorMessage: error.message };
    }
    if (error instanceof WebhookTimeoutError) {
      metrics.increment(MetricName.WEBHOOK_OUTCOME, { outcome: "timeout" });
      return { status: "failed", retryable: true, errorClass: "connection", errorMessage: error.message };
    }
    if (error instanceof WebhookConnectionError) {
      // Nothing could have reached the server yet — safe to retry.
      metrics.increment(MetricName.WEBHOOK_OUTCOME, { outcome: "connection_error" });
      return { status: "failed", retryable: true, errorClass: "connection", errorMessage: error.message };
    }
    // Any other unexpected transport error: conservative default is retryable,
    // never a silent permanent give-up for a shape of failure this code doesn't
    // specifically recognize.
    metrics.increment(MetricName.WEBHOOK_OUTCOME, { outcome: "connection_error" });
    return {
      status: "failed",
      retryable: true,
      errorClass: "connection",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

function webhookOutcomeLabel(outcome: ExecutionOutcome): "success" | "retryable" | "permanent" | "ambiguous" {
  if (outcome.status === "succeeded") return "success";
  if (outcome.status === "ambiguous") return "ambiguous";
  return outcome.retryable ? "retryable" : "permanent";
}

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Response classification matrix (Phase 5B §9), exercised directly by
 * webhookExecutor.test.ts:
 *   2xx                            -> succeeded
 *   408, 429, 500, 502, 503, 504   -> retryable failure
 *   any other 4xx                  -> permanent failure (an auth/config error does
 *                                      not fix itself by retrying)
 *   any other status (1xx, 3xx reaching us unexpectedly, an unlisted 5xx, ...)
 *                                  -> retryable failure — a conservative default,
 *                                      never a silent success or silent
 *                                      permanent give-up for a status this
 *                                      matrix doesn't explicitly recognize.
 */
export function classifyWebhookResponse(statusCode: number): ExecutionOutcome {
  if (statusCode >= 200 && statusCode < 300) {
    return { status: "succeeded", responseMetadata: { statusCode } };
  }
  if (RETRYABLE_STATUS_CODES.has(statusCode)) {
    return {
      status: "failed",
      retryable: true,
      errorClass: `http_${statusCode}`,
      errorMessage: `webhook endpoint responded ${statusCode}`,
    };
  }
  if (statusCode >= 400 && statusCode < 500) {
    return {
      status: "failed",
      retryable: false,
      errorClass: `http_${statusCode}`,
      errorMessage: `webhook endpoint responded ${statusCode}`,
    };
  }
  return {
    status: "failed",
    retryable: true,
    errorClass: `http_${statusCode}`,
    errorMessage: `webhook endpoint responded with unexpected status ${statusCode}`,
  };
}
