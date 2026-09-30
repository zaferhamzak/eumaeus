import { createHash, randomBytes } from "node:crypto";

/**
 * Membership invite tokens: a one-time bearer credential, not a
 * human-chosen secret — so a fast SHA-256 hash (not argon2) is the right
 * primitive here, the same distinction secretCrypto.ts's docstring draws
 * between "reversible encryption for something we must read back" and this
 * case, "only ever needs equality-checking, never recovery." The RAW token
 * is returned once, in the invite-creation API response, and is NEVER
 * persisted anywhere — only hashInviteToken()'s output goes into
 * Membership.inviteTokenHash.
 */
export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
