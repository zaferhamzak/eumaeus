import { describe, expect, it } from "vitest";
import { TOTP, Secret } from "otpauth";
import { generateTotpSecret, buildEnrollmentUri, verifyTotpCode } from "../../src/modules/auth/mfa.js";

describe("mfa — TOTP generation/verification", () => {
  it("generates a base32 secret usable to build a valid otpauth:// enrollment URI", () => {
    const secret = generateTotpSecret();
    const uri = buildEnrollmentUri("user@example.com", secret);
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain(encodeURIComponent("user@example.com").replace(/%40/g, "%40"));
    expect(uri).toContain(`secret=${secret}`);
  });

  it("round-trips: a code generated for a secret verifies successfully against that same secret", () => {
    const secret = generateTotpSecret();
    const code = new TOTP({ secret }).generate();
    expect(verifyTotpCode(secret, code)).toBe(true);
  });

  it("rejects a code generated for a DIFFERENT secret", () => {
    const secretA = generateTotpSecret();
    const secretB = generateTotpSecret();
    const codeForB = new TOTP({ secret: secretB }).generate();
    expect(verifyTotpCode(secretA, codeForB)).toBe(false);
  });

  it("rejects a malformed/garbage code", () => {
    const secret = generateTotpSecret();
    expect(verifyTotpCode(secret, "not-a-code")).toBe(false);
    expect(verifyTotpCode(secret, "000000")).toBe(false);
  });

  it("accepts a code from one time-step earlier (clock-skew window), rejects one far outside it", () => {
    const secret = new Secret().base32;
    const totp = new TOTP({ secret });
    const oneStepEarlier = totp.generate({ timestamp: Date.now() - 30_000 });
    const farInThePast = totp.generate({ timestamp: Date.now() - 10 * 60_000 });
    expect(verifyTotpCode(secret, oneStepEarlier)).toBe(true);
    expect(verifyTotpCode(secret, farInThePast)).toBe(false);
  });
});
