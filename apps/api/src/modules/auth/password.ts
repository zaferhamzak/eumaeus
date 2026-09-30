import { hash, verify, argon2id, type HashOptions } from "argon2";

/**
 * Password hashing for User.passwordHash — argon2id (OWASP's recommended
 * default: memory-hard, resists GPU/ASIC cracking far better than bcrypt, no
 * 72-byte input-truncation footgun). Options are pinned explicitly rather
 * than left to the library's defaults, so a future argon2 version bump can't
 * silently change (weaken or just unexpectedly alter) the cost parameters
 * already-hashed rows were created under — argon2's own encoded hash format
 * embeds the parameters used, so verify() always works regardless, but
 * pinning here keeps NEW hashes deterministic across upgrades.
 */
const ARGON2_OPTIONS: HashOptions = {
  type: argon2id,
  memoryCost: 19456, // 19 MiB — OWASP's current minimum recommendation for argon2id
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2_OPTIONS);
}

export function verifyPassword(digest: string, plaintext: string): Promise<boolean> {
  return verify(digest, plaintext);
}
