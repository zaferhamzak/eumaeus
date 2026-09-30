import * as http from "node:http";
import * as https from "node:https";
import type { LookupAddress } from "node:dns";

/**
 * The actual HTTP transport for the webhook executor — deliberately a thin,
 * injectable seam (mirrors ArchiveClientFactory in archiveExecutor.ts) so
 * webhookExecutor.test.ts never makes a real network call.
 *
 * Uses Node's core http/https modules directly, NOT the global fetch(), because
 * fetch() offers no supported way to pin a request to a pre-validated IP address
 * while still sending the correct Host header and TLS SNI/certificate hostname —
 * exactly what `lookup` below does, and exactly what closes the gap between
 * ssrf.ts's DNS check and the real connection (DNS rebinding).
 */
export interface WebhookRequestInput {
  /** The original URL — used for the request path, Host header, and (for https) TLS SNI/certificate hostname. */
  url: string;
  /** The specific IP address ssrf.ts already validated as safe — the connection is forced to this exact address, never re-resolved. */
  address: string;
  family: 4 | 6;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  /** Phase 19: read the response body (up to MAX_CAPTURED_BODY_BYTES) — Jira/Zendesk return the created issue's key there. */
  captureBody?: boolean;
}

export interface WebhookHttpResult {
  statusCode: number;
  /** Only with captureBody. */
  body?: string;
}

const MAX_CAPTURED_BODY_BYTES = 64 * 1024;

/** The request could not have reached the server — nothing happened remotely; safe to retry. */
export class WebhookConnectionError extends Error {}
/** No response arrived within the timeout, but the request had not yet been fully sent — nothing could have happened remotely yet. */
export class WebhookTimeoutError extends Error {}
/** The request was fully sent (or a timeout/connection break happened only AFTER it was fully sent) before any response was received — the remote side may have processed it. This is the "succeeded but response lost" ambiguity. */
export class WebhookResponseLostError extends Error {}

export function performWebhookRequest(input: WebhookRequestInput): Promise<WebhookHttpResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const parsed = new URL(input.url);
    const isHttps = parsed.protocol === "https:";
    const transport = isHttps ? https : http;

    let requestFinished = false;

    // `autoSelectFamily` (Happy-Eyeballs dual-stack racing) is a genuine Node
    // net.connect() option forwarded through http(s).request(), but is missing
    // from this project's @types/node version's RequestOptions — hence the cast.
    // Typed as https.RequestOptions (a superset of http.RequestOptions that also
    // includes TLS options like `servername`) since `transport` is chosen
    // dynamically — the extra TLS-only fields are simply ignored by plain
    // http.request() at runtime when the URL is http:.
    const requestOptions: https.RequestOptions & { autoSelectFamily?: boolean } = {
      hostname: parsed.hostname,
      // Force the TCP connection to the pre-validated IP — NOT a fresh DNS
      // lookup performed by net/tls at connect time. This is what actually
      // prevents DNS rebinding between ssrf.ts's check and this request:
      // whatever the hostname resolves to NOW is irrelevant, only the address
      // already validated is ever dialed. Handles BOTH invocation shapes
      // Node's net layer can use for a custom `lookup`: the legacy
      // single-result form ((err, address, family) => void) and the
      // `all: true` form used when Happy-Eyeballs/autoSelectFamily requests a
      // full address list — without this, Node's default autoSelectFamily
      // behavior (dual-stack racing) calls back expecting an array and a
      // single-string response corrupts the connection with an
      // "Invalid IP address: undefined" internal error.
      lookup: (
        _hostname: string,
        options: unknown,
        callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
      ) => {
        const wantsAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
        if (wantsAll) {
          callback(null, [{ address: input.address, family: input.family }]);
        } else {
          callback(null, input.address, input.family);
        }
      },
      // Belt-and-suspenders alongside the `all`-aware lookup above: this
      // request is only ever meant to reach the ONE address ssrf.ts already
      // validated — dual-stack racing across multiple resolved addresses is
      // never appropriate here regardless of Node's default.
      autoSelectFamily: false,
      port: parsed.port ? Number(parsed.port) : isHttps ? 443 : 80,
      path: `${parsed.pathname}${parsed.search}`,
      method: "POST",
      headers: { ...input.headers, "Content-Length": Buffer.byteLength(input.body) },
      // TLS SNI + certificate hostname verification still target the ORIGINAL
      // hostname (correct, since we're connecting to that host's IP, just
      // without a second DNS round-trip) — only the socket's destination
      // address is pinned above.
      servername: isHttps ? parsed.hostname : undefined,
      timeout: input.timeoutMs,
    };

    const req = transport.request(
      requestOptions,
      (res) => {
        // Classification only needs the status code (see webhookExecutor.ts's
        // response-code matrix) — drain and discard the body rather than making
        // the outcome depend on the body stream also completing cleanly.
        if (!input.captureBody) {
          res.resume();
          settle(() => resolve({ statusCode: res.statusCode ?? 0 }));
          return;
        }
        // The status line has arrived, so the request definitely reached the
        // server: from here on, settle with whatever body was read, never
        // with a transport error (that would wrongly read as "maybe not sent").
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          if (size < MAX_CAPTURED_BODY_BYTES) chunks.push(chunk.subarray(0, MAX_CAPTURED_BODY_BYTES - size));
          size += chunk.length;
        });
        const done = () => settle(() => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("end", done);
        res.on("error", done);
        res.on("close", done);
      },
    );

    req.on("finish", () => {
      requestFinished = true;
    });

    req.on("timeout", () => {
      req.destroy(
        requestFinished
          ? new WebhookResponseLostError(`timed out waiting for a response after ${input.timeoutMs}ms`)
          : new WebhookTimeoutError(`timed out sending the request within ${input.timeoutMs}ms`),
      );
    });

    req.on("error", (error) => {
      if (error instanceof WebhookResponseLostError || error instanceof WebhookTimeoutError) {
        settle(() => reject(error));
        return;
      }
      settle(() =>
        reject(requestFinished ? new WebhookResponseLostError(error.message) : new WebhookConnectionError(error.message)),
      );
    });

    req.write(input.body);
    req.end();
  });
}
