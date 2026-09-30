import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../src/modules/auth/password.js";

describe("password — argon2id hashing", () => {
  it("round-trips: hash then verify with the same plaintext succeeds", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    await expect(verifyPassword(hash, "correct-horse-battery-staple")).resolves.toBe(true);
  });

  it("rejects the wrong plaintext", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    await expect(verifyPassword(hash, "wrong-password")).resolves.toBe(false);
  });

  it("never stores the plaintext — the hash string looks nothing like the input", async () => {
    const hash = await hashPassword("a-very-recognizable-password");
    expect(hash).not.toContain("a-very-recognizable-password");
    expect(hash.startsWith("$argon2id$")).toBe(true);
  });

  it("hashing the same plaintext twice produces different hashes (random salt per call)", async () => {
    const a = await hashPassword("same-input");
    const b = await hashPassword("same-input");
    expect(a).not.toBe(b);
  });
});
