import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

/**
 * Phase 7 §25: "Sensitive values must never be printed in startup logs...
 * Startup diagnostics may list variable names and validation status, but not
 * values." config/env.ts's zod schema already never interpolates a rejected
 * value into its own error messages (every `.refine()`/`.min()` message here
 * is a fixed string) — this file proves that empirically rather than only by
 * code review, using the same vi.resetModules() + fresh dynamic import
 * pattern as secretEncryptionKeyValidation.test.ts (loadEnv() caches its
 * result for the process lifetime, so re-importing is required to actually
 * re-run validation against a mutated process.env).
 */
describe("config validation never leaks sensitive values into error messages", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it("an invalid SECRET_ENCRYPTION_KEY value never appears in the thrown error", async () => {
    vi.resetModules();
    const recognizableSecret = "MyRecognizableInvalidSecretValue123";
    process.env.SECRET_ENCRYPTION_KEY = recognizableSecret;
    const { loadEnv } = await import("../../src/config/env.js");
    try {
      loadEnv();
      expect.fail("expected loadEnv() to throw for an invalid key");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(recognizableSecret);
      expect(message).toContain("SECRET_ENCRYPTION_KEY"); // the field NAME is fine to show
    }
  });

  it("a missing DATABASE_URL error names the field, not any value", async () => {
    vi.resetModules();
    delete process.env.DATABASE_URL;
    const { loadEnv } = await import("../../src/config/env.js");
    expect(() => loadEnv()).toThrow(/DATABASE_URL/);
  });

  it("SHUTDOWN_GRACE_PERIOD_MS has a safe positive default and rejects a non-positive override", async () => {
    vi.resetModules();
    delete process.env.SHUTDOWN_GRACE_PERIOD_MS;
    process.env.SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    const withDefault = await import("../../src/config/env.js");
    expect(withDefault.loadEnv().SHUTDOWN_GRACE_PERIOD_MS).toBeGreaterThan(0);

    vi.resetModules();
    process.env.SHUTDOWN_GRACE_PERIOD_MS = "-5";
    const { loadEnv: loadEnvInvalid } = await import("../../src/config/env.js");
    expect(() => loadEnvInvalid()).toThrow(/SHUTDOWN_GRACE_PERIOD_MS/);
  });
});
