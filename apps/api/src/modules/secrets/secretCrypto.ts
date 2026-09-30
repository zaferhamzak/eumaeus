import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { loadEnv } from "../../config/env.js";

/**
 * Application-level authenticated encryption for secrets that must be stored
 * (DestinationSecret.encryptedValue — Phase 5B's webhook signing secrets). NOT a
 * key-management system: the key itself comes from one env var
 * (SECRET_ENCRYPTION_KEY, validated at startup by config/env.ts), exactly the same
 * "read from env at call time, never persisted" posture as MAIL_PASSWORD and
 * JEV_API_KEY. KMS/cloud secret managers are explicitly out of scope for this phase.
 *
 * Primitive: AES-256-GCM (authenticated encryption — a tampered or truncated
 * ciphertext fails to decrypt rather than silently returning corrupted plaintext).
 * A fresh random 12-byte IV is generated for every encryption call, so encrypting
 * the same plaintext twice never produces the same ciphertext.
 *
 * Packed format (a single string, so DestinationSecret.encryptedValue stays one
 * column, not three): "v1.<ivHex>.<authTagHex>.<ciphertextHex>" — versioned so a
 * future algorithm change is detectable and additive, not a silent reinterpretation
 * of old rows.
 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12; // 96-bit nonce — the recommended/standard size for GCM
const FORMAT_VERSION = "v1";

function getKey(): Buffer {
  // loadEnv() itself already fails startup if SECRET_ENCRYPTION_KEY is missing or
  // not exactly 32 bytes once base64-decoded — this function trusts that
  // validation rather than re-deriving/relaxing it here.
  return Buffer.from(loadEnv().SECRET_ENCRYPTION_KEY, "base64");
}

/** Startup/config validation hook — throws synchronously if the configured key is missing or malformed. Called once at process start (see src/worker.ts), so a misconfigured deployment fails immediately rather than the first time a webhook secret is touched. */
export function validateSecretKey(): void {
  const key = getKey();
  if (key.length !== 32) {
    throw new Error(`SECRET_ENCRYPTION_KEY must decode to exactly 32 bytes, got ${key.length}`);
  }
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [FORMAT_VERSION, iv.toString("hex"), authTag.toString("hex"), ciphertext.toString("hex")].join(".");
}

export class SecretDecryptionError extends Error {}

export function decryptSecret(packed: string): string {
  const parts = packed.split(".");
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    // Malformed/unknown format — never attempt a "best effort" decrypt of
    // something that isn't in the shape this module itself wrote.
    throw new SecretDecryptionError("encrypted secret is not in the expected v1 packed format");
  }
  const [, ivHex, authTagHex, ciphertextHex] = parts;

  const key = getKey();
  let iv: Buffer;
  let authTag: Buffer;
  let ciphertext: Buffer;
  try {
    iv = Buffer.from(ivHex as string, "hex");
    authTag = Buffer.from(authTagHex as string, "hex");
    ciphertext = Buffer.from(ciphertextHex as string, "hex");
  } catch {
    throw new SecretDecryptionError("encrypted secret contains malformed hex data");
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  try {
    // GCM authenticates before returning plaintext: final() throws if the
    // ciphertext or tag was tampered with, truncated, or decrypted under the
    // wrong key — this is what "decryption must authenticate before returning
    // plaintext" means in practice, not a separate manual check.
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    throw new SecretDecryptionError("secret failed authentication — ciphertext, tag, or key mismatch");
  }
}
