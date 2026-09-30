import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

/**
 * Request ID policy (Phase 6 brief §5), documented here because it's a security
 * decision, not just a format choice: an incoming X-Request-Id is trusted and
 * echoed back ONLY if it looks like a reasonable opaque token — bounded length,
 * a safe character set. A header value is client-controlled input that gets
 * reflected back in the response and written into structured logs; accepting an
 * arbitrary string here would be a log/header-injection surface for free. An
 * incoming value that fails this check is treated as absent (a fresh id is
 * generated), not rejected — a malformed request id must never itself become a
 * reason to fail the request.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

export function isAcceptableRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

/** Wired via Fastify's own `genReqId` (called once per request, before any hook) so `request.id` is correct from the very first log line the framework itself emits. */
export function genRequestId(req: { headers: Record<string, unknown> }): string {
  const incoming = req.headers["x-request-id"];
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  if (isAcceptableRequestId(candidate)) return candidate;
  return randomUUID();
}

/** Always echoes the resolved request id back on the response — the client's own value when it was acceptable, otherwise the generated one. */
export function registerRequestIdPlugin(app: FastifyInstance): void {
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Request-Id", request.id);
    return payload;
  });
}
