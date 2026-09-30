import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { ApiError } from "../errors/ApiError.js";

interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

/**
 * The ONLY place an HTTP response is produced from a thrown error (Phase 6 brief
 * §4). Never leaks Prisma internals, SQL, stack traces, or secret values — those
 * are logged server-side (via app.log, which already redacts nothing further
 * back than this: routes/services must never construct an error message out of
 * a secret in the first place) but never placed in the response body.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;

    if (error instanceof ApiError) {
      request.log.info({ requestId, code: error.code, statusCode: error.statusCode }, error.message);
      const body: ApiErrorBody = { error: { code: error.code, message: error.message, requestId } };
      if (error.details !== undefined) body.error.details = error.details;
      return reply.status(error.statusCode).send(body);
    }

    if (error instanceof ZodError) {
      request.log.info({ requestId, issues: error.issues }, "request validation failed");
      const body: ApiErrorBody = {
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          requestId,
          details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        },
      };
      return reply.status(400).send(body);
    }

    // Fastify's own built-in request parsing/validation errors (malformed JSON
    // body, payload too large, etc.) carry a `statusCode` already in the 4xx
    // range — treated as a client validation problem, never leaking the
    // underlying parser's own message verbatim beyond what Fastify already
    // produces for this class of error.
    const fastifyStatus = (error as { statusCode?: number }).statusCode;
    if (typeof fastifyStatus === "number" && fastifyStatus >= 400 && fastifyStatus < 500) {
      request.log.info({ requestId, statusCode: fastifyStatus }, (error as Error).message);
      const body: ApiErrorBody = {
        error: { code: "VALIDATION_ERROR", message: "The request could not be processed", requestId },
      };
      return reply.status(fastifyStatus).send(body);
    }

    // Unrecognized/unexpected error — logged in FULL server-side (this is the
    // one place a stack trace is allowed to exist), but the client only ever
    // sees a generic, safe message.
    request.log.error({ requestId, err: error }, "unhandled error");
    const body: ApiErrorBody = { error: { code: "INTERNAL_ERROR", message: "An internal error occurred", requestId } };
    return reply.status(500).send(body);
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const body: ApiErrorBody = {
      error: { code: "RESOURCE_NOT_FOUND", message: `No route matches ${request.method} ${request.url}`, requestId: request.id },
    };
    return reply.status(404).send(body);
  });
}
