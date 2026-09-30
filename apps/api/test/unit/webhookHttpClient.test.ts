import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  performWebhookRequest,
  WebhookConnectionError,
  WebhookResponseLostError,
  WebhookTimeoutError,
} from "../../src/modules/destinations/executors/webhookHttpClient.js";

/**
 * Real sockets against a local ephemeral server — not mocked classes — so the
 * "finished vs. not finished when the failure happened" distinction (which is what
 * separates a genuinely-safe-to-retry connection failure from a
 * succeeded-but-response-lost ambiguity) is proven against actual Node stream/
 * socket behavior, not just asserted by code review.
 */
let server: Server | undefined;

afterEach(async () => {
  if (server) {
    // closeAllConnections forcibly ends any still-open sockets (e.g. a client
    // left mid-send when a test's own timeout fired) — without it, a lingering
    // half-open connection makes plain server.close() hang waiting for it to
    // end on its own, which it never will once the client side has already
    // rejected and stopped writing.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

describe("performWebhookRequest — real sockets", () => {
  it("connects to the pre-validated address/port from the URL, ignoring what the hostname would otherwise resolve to", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });

    const result = await performWebhookRequest({
      url: `http://this-hostname-does-not-need-to-resolve.invalid:${port}/hook`,
      address: "127.0.0.1", // the real, pre-validated connect target
      family: 4,
      headers: {},
      body: "{}",
      timeoutMs: 2000,
    });
    expect(result.statusCode).toBe(200);
  });

  it("a large response body (§16) is drained and discarded, never buffered — a malicious/misbehaving webhook endpoint cannot cause unbounded memory growth via its response", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200);
      // Stream a large response body (well beyond anything reasonable) — if
      // performWebhookRequest buffered this, memory would spike proportional
      // to its size; res.resume() in the implementation drains and discards
      // it instead, so this must resolve quickly with only the status code.
      const chunk = Buffer.alloc(1024 * 1024, "x"); // 1 MiB
      let written = 0;
      const writeMore = () => {
        while (written < 50 * 1024 * 1024) {
          // 50 MiB total
          written += chunk.length;
          if (!res.write(chunk)) {
            res.once("drain", writeMore);
            return;
          }
        }
        res.end();
      };
      writeMore();
    });

    const start = Date.now();
    const result = await performWebhookRequest({
      url: `http://placeholder.invalid:${port}/hook`,
      address: "127.0.0.1",
      family: 4,
      headers: {},
      body: "{}",
      timeoutMs: 5000,
    });
    expect(result.statusCode).toBe(200);
    expect(Date.now() - start).toBeLessThan(5000); // resolved well before any artificial slowness would be needed to buffer 50 MiB
  });

  it("a 4xx/5xx status is still returned as a normal result, not an error", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(503);
      res.end();
    });

    const result = await performWebhookRequest({
      url: `http://placeholder.invalid:${port}/hook`,
      address: "127.0.0.1",
      family: 4,
      headers: {},
      body: "{}",
      timeoutMs: 2000,
    });
    expect(result.statusCode).toBe(503);
  });

  it("nothing listening on the target port -> a connection error (nothing could have reached the server)", async () => {
    const port = await listen((_req, res) => res.end());
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined; // now genuinely nothing is listening on `port`

    await expect(
      performWebhookRequest({
        url: `http://placeholder.invalid:${port}/hook`,
        address: "127.0.0.1",
        family: 4,
        headers: {},
        body: "{}",
        timeoutMs: 2000,
      }),
    ).rejects.toBeInstanceOf(WebhookConnectionError);
  });

  it("the server reads the request then destroys the connection without responding -> response-lost (ambiguous), not a plain connection error", async () => {
    const port = await listen((req, res) => {
      void res;
      req.on("data", () => {
        // drain the body
      });
      req.on("end", () => {
        // The request was fully received server-side, then the connection is
        // killed before any response is sent — exactly the "operation may have
        // been processed, but the response never arrived" ambiguity.
        req.socket.destroy();
      });
    });

    await expect(
      performWebhookRequest({
        url: `http://placeholder.invalid:${port}/hook`,
        address: "127.0.0.1",
        family: 4,
        headers: {},
        body: JSON.stringify({ hello: "world" }),
        timeoutMs: 2000,
      }),
    ).rejects.toBeInstanceOf(WebhookResponseLostError);
  });

  it("a timeout after the request body was fully sent is classified as response-lost (ambiguous), not a plain retryable timeout", async () => {
    const port = await listen((req, res) => {
      void res;
      // Read and discard the body, then never respond — the client's own
      // request finishes sending (small body), so the timeout that eventually
      // fires happens strictly AFTER `finish`.
      req.resume();
    });

    await expect(
      performWebhookRequest({
        url: `http://placeholder.invalid:${port}/hook`,
        address: "127.0.0.1",
        family: 4,
        headers: {},
        body: "{}",
        timeoutMs: 150,
      }),
    ).rejects.toBeInstanceOf(WebhookResponseLostError);
  });

  it("a timeout BEFORE the request finished sending is classified as a plain retryable timeout, not response-lost (Phase 7: closes the gap left open in Phase 5B)", async () => {
    // The server accepts the TCP connection but never reads a single byte from
    // it (no data handler, no .resume()) — Node leaves the request stream
    // paused by default, so the OS receive buffer fills once enough bytes
    // arrive and TCP flow control then blocks the CLIENT's own writes. A large
    // body (several MB, far bigger than typical OS socket buffers) combined
    // with a short timeout reliably triggers the timeout while the client is
    // still mid-send — genuinely BEFORE 'finish', not after.
    const port = await listen(() => {
      // deliberately does nothing with `req` — never drains it
    });

    const largeBody = "x".repeat(20 * 1024 * 1024); // 20 MB

    await expect(
      performWebhookRequest({
        url: `http://placeholder.invalid:${port}/hook`,
        address: "127.0.0.1",
        family: 4,
        headers: {},
        body: largeBody,
        timeoutMs: 50,
      }),
    ).rejects.toBeInstanceOf(WebhookTimeoutError);
  });
});
