/**
 * The one consistent API error model (Phase 6 brief §4). Every route handler and
 * service function that wants to fail in an HTTP-meaningful way throws one of
 * these — the error handler plugin (plugins/errorHandler.ts) is the ONLY place
 * that turns a thrown error into an HTTP response, so the shape can never drift
 * between routes.
 */
export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "RESOURCE_NOT_FOUND"
  | "CONFLICT"
  | "INVALID_STATE"
  | "CONFIGURATION_ERROR"
  | "INTERNAL_ERROR"
  | "NOT_IMPLEMENTED"
  // --- Phase 7: reliability hardening ---
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE"
  // --- Phase 11: authentication ---
  | "UNAUTHORIZED"
  | "FORBIDDEN";

export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly statusCode: number,
    /** Safe-to-return structured detail (e.g. field-level validation errors) — never raw internals (SQL, stack traces, secret values). */
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class ValidationError extends ApiError {
  constructor(message: string, details?: unknown) {
    super("VALIDATION_ERROR", message, 400, details);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends ApiError {
  constructor(message: string) {
    super("RESOURCE_NOT_FOUND", message, 404);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends ApiError {
  constructor(message: string, details?: unknown) {
    super("CONFLICT", message, 409, details);
    this.name = "ConflictError";
  }
}

/** The resource exists and the request is well-formed, but the resource's current state doesn't allow this operation (e.g. retrying a succeeded ActionExecution). */
export class InvalidStateError extends ApiError {
  constructor(message: string) {
    super("INVALID_STATE", message, 409);
    this.name = "InvalidStateError";
  }
}

/** A server-side configuration problem (e.g. a required env var), not a client mistake. */
export class ConfigurationError extends ApiError {
  constructor(message: string) {
    super("CONFIGURATION_ERROR", message, 500);
    this.name = "ConfigurationError";
  }
}

export class NotImplementedApiError extends ApiError {
  constructor(message: string) {
    super("NOT_IMPLEMENTED", message, 501);
    this.name = "NotImplementedApiError";
  }
}

export class RateLimitedError extends ApiError {
  constructor(message: string, public readonly retryAfterSeconds: number) {
    super("RATE_LIMITED", message, 429, { retryAfterSeconds });
    this.name = "RateLimitedError";
  }
}

/** The instance is draining/stopped and cannot safely accept new work — see runtime/state.ts. */
export class ServiceUnavailableError extends ApiError {
  constructor(message: string) {
    super("SERVICE_UNAVAILABLE", message, 503);
    this.name = "ServiceUnavailableError";
  }
}

/** No valid session at all — request.user is null on a route that requires being logged in. */
export class UnauthorizedError extends ApiError {
  constructor(message: string) {
    super("UNAUTHORIZED", message, 401);
    this.name = "UnauthorizedError";
  }
}

/** Logged in, but not allowed to do THIS — no Membership in the target organization, a Membership missing the required permission, or a non-superAdmin attempting a superAdmin-only action. */
export class ForbiddenError extends ApiError {
  constructor(message: string) {
    super("FORBIDDEN", message, 403);
    this.name = "ForbiddenError";
  }
}
