import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, REDACTED_KEYS } from "../../src/logger.js";

/**
 * Uses the SAME factory src/logger.ts's shared `logger` instance is built
 * from (`createLogger`), pointed at an in-memory stream instead of stdout —
 * so this proves the ACTUAL configured redaction behaves correctly (§9), not
 * a hand-copied duplicate of the key list.
 */
function capturingLogger() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { logger: createLogger(stream), lines: () => chunks.join("") };
}

describe("shared logger (src/logger.ts) — redaction", () => {
  it("redacts a top-level password field", () => {
    const { logger, lines } = capturingLogger();
    logger.info({ password: "super-secret-password-value" }, "test");
    expect(lines()).not.toContain("super-secret-password-value");
    expect(lines()).toContain("[Redacted]");
  });

  it("redacts a nested secret field (e.g. inside a destination config)", () => {
    const { logger, lines } = capturingLogger();
    logger.info({ destination: { secret: "webhook-hmac-secret-value" } }, "test");
    expect(lines()).not.toContain("webhook-hmac-secret-value");
  });

  it("redacts an Authorization header value", () => {
    const { logger, lines } = capturingLogger();
    logger.info({ headers: { authorization: "Bearer some-real-token" } }, "test");
    expect(lines()).not.toContain("some-real-token");
  });

  it("redacts MAIL_PASSWORD/JEV_API_KEY/SECRET_ENCRYPTION_KEY by name, wherever they appear", () => {
    const { logger, lines } = capturingLogger();
    logger.info({ env: { MAIL_PASSWORD: "imap-password-value", JEV_API_KEY: "jev-key-value", SECRET_ENCRYPTION_KEY: "enc-key-value" } }, "test");
    const output = lines();
    expect(output).not.toContain("imap-password-value");
    expect(output).not.toContain("jev-key-value");
    expect(output).not.toContain("enc-key-value");
  });

  it("does not redact ordinary, non-sensitive fields", () => {
    const { logger, lines } = capturingLogger();
    logger.info({ requestId: "abc-123", route: "/api/v1/emails/:id" }, "test");
    expect(lines()).toContain("abc-123");
    expect(lines()).toContain("/api/v1/emails/:id");
  });

  it("the configured redact list explicitly covers every §9-forbidden key name", () => {
    for (const required of ["password", "secret", "authorization", "hmacSecret", "encryptedValue", "encryptionKey", "MAIL_PASSWORD", "JEV_API_KEY", "SECRET_ENCRYPTION_KEY"]) {
      expect(REDACTED_KEYS.some((path) => path === required || path === `*.${required}`)).toBe(true);
    }
  });
});
