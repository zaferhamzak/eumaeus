import { describe, expect, it } from "vitest";
import { generateInviteToken, hashInviteToken } from "../../src/modules/auth/inviteToken.js";

describe("inviteToken", () => {
  it("generates a high-entropy, URL-safe token", () => {
    const token = generateInviteToken();
    expect(token.length).toBeGreaterThan(30);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generates a different token on each call", () => {
    expect(generateInviteToken()).not.toBe(generateInviteToken());
  });

  it("hashing is deterministic — the same token always hashes to the same value", () => {
    const token = generateInviteToken();
    expect(hashInviteToken(token)).toBe(hashInviteToken(token));
  });

  it("different tokens hash to different values", () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(hashInviteToken(a)).not.toBe(hashInviteToken(b));
  });

  it("the hash never contains the raw token", () => {
    const token = generateInviteToken();
    expect(hashInviteToken(token)).not.toContain(token);
  });
});
