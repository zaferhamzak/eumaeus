import pino from "pino";

/**
 * One shared structured logger for BOTH runtime processes (worker.ts and
 * server.ts) — previously worker.ts used plain `console.log`/`console.error`
 * (unstructured) while server.ts only had Fastify's own per-request pino
 * instance, with nothing shared between them. This is that shared instance;
 * `api/server.ts` passes it to Fastify via the `loggerInstance` option instead
 * of letting Fastify construct its own, so request logs and worker logs share
 * one format or destination.
 *
 * Redaction (Phase 7 §9's explicit "do NOT log" list): pino's `redact` option
 * replaces matching paths with "[Redacted]" — a structural guarantee, not
 * "hope nobody logs it by accident." Applies at any nesting depth those key
 * names appear in a logged object. Exported (not just used inline) so
 * test/unit/logger.test.ts can build an identical logger pointed at a
 * capturing stream instead of stdout, and prove the ACTUAL configured list
 * redacts real values, not just a hand-copied duplicate of it.
 */
export const REDACTED_KEYS = [
  "password",
  "*.password",
  "secret",
  "*.secret",
  "secretValue",
  "*.secretValue",
  "encryptionKey",
  "*.encryptionKey",
  "encryptedValue",
  "*.encryptedValue",
  "authorization",
  "*.authorization",
  "headers.authorization",
  "hmacSecret",
  "*.hmacSecret",
  // Env-var-style names, at the top level AND at any nesting depth (a plain
  // "MAIL_PASSWORD" path only matches at the top level — pino's wildcard
  // prefix is required to catch it nested under e.g. `{ env: { MAIL_PASSWORD
  // } }`, which is exactly the shape a startup/config diagnostic log would
  // use). Found and fixed via test/unit/logger.test.ts actually asserting
  // against real pino output, not just by inspection.
  "MAIL_PASSWORD",
  "*.MAIL_PASSWORD",
  "JEV_API_KEY",
  "*.JEV_API_KEY",
  "SECRET_ENCRYPTION_KEY",
  "*.SECRET_ENCRYPTION_KEY",
];

export function createLogger(destination?: pino.DestinationStream): pino.Logger {
  const options: pino.LoggerOptions = {
    level: process.env.LOG_LEVEL ?? "info",
    redact: { paths: REDACTED_KEYS, censor: "[Redacted]" },
    base: {
      service: "eumaeus-api",
      env: process.env.NODE_ENV ?? "development",
    },
  };
  return destination ? pino(options, destination) : pino(options);
}

export const logger = createLogger();

export type Logger = typeof logger;
