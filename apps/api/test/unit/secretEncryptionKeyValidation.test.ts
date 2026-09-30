import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

/**
 * config/env.ts caches its parsed result for the life of the process
 * (`let cached: Env | undefined`), and test/setup.ts already sets a valid
 * SECRET_ENCRYPTION_KEY before any test file's own code runs — so testing
 * "startup fails on a missing/invalid key" against the normally-imported loadEnv()
 * would just see the already-cached valid value. Each test here uses
 * vi.resetModules() + a fresh dynamic import to get its own uncached env.ts
 * instance, mutates process.env immediately beforehand, and restores it in
 * afterEach — the module-level bindings other test files use (imported normally,
 * at the top of their own files) are unaffected by this.
 */
describe("SECRET_ENCRYPTION_KEY startup/config validation", () => {
  const originalKey = process.env.SECRET_ENCRYPTION_KEY;

  afterEach(() => {
    process.env.SECRET_ENCRYPTION_KEY = originalKey;
  });

  it("fails config validation if the key is missing", async () => {
    vi.resetModules();
    delete process.env.SECRET_ENCRYPTION_KEY;
    const { loadEnv } = await import("../../src/config/env.js");
    expect(() => loadEnv()).toThrow(/SECRET_ENCRYPTION_KEY/);
  });

  it("fails config validation if the key is not valid base64 of the right length (too short)", async () => {
    vi.resetModules();
    process.env.SECRET_ENCRYPTION_KEY = Buffer.from("too-short-key").toString("base64");
    const { loadEnv } = await import("../../src/config/env.js");
    expect(() => loadEnv()).toThrow(/SECRET_ENCRYPTION_KEY/);
  });

  it("fails config validation if the key decodes to too many bytes", async () => {
    vi.resetModules();
    process.env.SECRET_ENCRYPTION_KEY = randomBytes(48).toString("base64");
    const { loadEnv } = await import("../../src/config/env.js");
    expect(() => loadEnv()).toThrow(/SECRET_ENCRYPTION_KEY/);
  });

  it("accepts a well-formed 32-byte base64 key", async () => {
    vi.resetModules();
    process.env.SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    const { loadEnv } = await import("../../src/config/env.js");
    expect(() => loadEnv()).not.toThrow();
  });

  it("validateSecretKey() (the explicit worker-startup check) also rejects a malformed key", async () => {
    vi.resetModules();
    process.env.SECRET_ENCRYPTION_KEY = Buffer.from("nope").toString("base64");
    const { validateSecretKey } = await import("../../src/modules/secrets/secretCrypto.js");
    expect(() => validateSecretKey()).toThrow();
  });

  it("validateSecretKey() does not throw for a well-formed key", async () => {
    vi.resetModules();
    process.env.SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    const { validateSecretKey } = await import("../../src/modules/secrets/secretCrypto.js");
    expect(() => validateSecretKey()).not.toThrow();
  });
});
