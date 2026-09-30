import { describe, expect, it } from "vitest";
import { encryptSecret, decryptSecret, SecretDecryptionError } from "../../src/modules/secrets/secretCrypto.js";

describe("secretCrypto — AES-256-GCM encrypt/decrypt", () => {
  it("round-trips a plaintext value exactly", () => {
    const encrypted = encryptSecret("super-secret-webhook-key");
    expect(decryptSecret(encrypted)).toBe("super-secret-webhook-key");
  });

  it("uses a random IV — encrypting the same plaintext twice never produces the same ciphertext", () => {
    const a = encryptSecret("same-value");
    const b = encryptSecret("same-value");
    expect(a).not.toBe(b);
    // ...but both still decrypt back to the original value.
    expect(decryptSecret(a)).toBe("same-value");
    expect(decryptSecret(b)).toBe("same-value");
  });

  it("a tampered ciphertext fails authentication rather than returning corrupted plaintext", () => {
    const packed = encryptSecret("original-value");
    const [version, iv, authTag, ciphertext] = packed.split(".");
    const tamperedByte = (ciphertext as string).slice(0, -2) + (((ciphertext as string).slice(-2) === "00") ? "01" : "00");
    const tampered = [version, iv, authTag, tamperedByte].join(".");

    expect(() => decryptSecret(tampered)).toThrow(SecretDecryptionError);
  });

  it("a tampered authentication tag fails authentication", () => {
    const packed = encryptSecret("original-value");
    const [version, iv, authTag, ciphertext] = packed.split(".");
    const tamperedTag = (authTag as string).slice(0, -2) + (((authTag as string).slice(-2) === "00") ? "01" : "00");
    const tampered = [version, iv, tamperedTag, ciphertext].join(".");

    expect(() => decryptSecret(tampered)).toThrow(SecretDecryptionError);
  });

  it("a malformed/unrecognized packed format is rejected, not silently misparsed", () => {
    expect(() => decryptSecret("not-a-valid-packed-secret")).toThrow(SecretDecryptionError);
    expect(() => decryptSecret("v2.aa.bb.cc")).toThrow(SecretDecryptionError); // unknown version
  });
});
