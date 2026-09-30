import { getSessionRedis } from "./sessionStore.js";

/**
 * Brute-force protection for password and TOTP guessing. Counts failures per
 * account key (the lowercased email for password login, the user id for MFA
 * codes) in Redis — shared across API processes, unlike the in-process
 * per-IP rate limiter (api/plugins/rateLimit.ts), which alone can't stop a
 * slow distributed guess against one account. After MAX_FAILURES within
 * the window the key is locked until the window expires; a success clears it.
 *
 * Keyed by account, not IP: it's the account being attacked, and an
 * attacker rotating IPs would otherwise reset the count every time. The
 * trade-off — someone could deliberately lock a known email out for 15
 * minutes — is the standard, accepted one for this kind of lockout.
 */
const MAX_FAILURES = 5;
const WINDOW_SECONDS = 15 * 60;

function key(scope: "login" | "mfa", subject: string): string {
  return `auth_fail:${scope}:${subject.toLowerCase()}`;
}

export class TooManyAttemptsError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super(`Too many failed attempts — try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s)`);
  }
}

/** Throws TooManyAttemptsError if the subject is currently locked. Call BEFORE doing the (expensive, argon2) credential check, so a locked account costs an attacker nothing to hit and reveals nothing. */
export async function assertNotLocked(scope: "login" | "mfa", subject: string): Promise<void> {
  const redis = getSessionRedis();
  const count = Number((await redis.get(key(scope, subject))) ?? 0);
  if (count >= MAX_FAILURES) {
    const ttl = await redis.ttl(key(scope, subject));
    throw new TooManyAttemptsError(ttl > 0 ? ttl : WINDOW_SECONDS);
  }
}

export async function recordFailure(scope: "login" | "mfa", subject: string): Promise<void> {
  const redis = getSessionRedis();
  const k = key(scope, subject);
  const count = await redis.incr(k);
  // The window starts at the FIRST failure and is not extended by later ones.
  if (count === 1) await redis.expire(k, WINDOW_SECONDS);
}

export async function clearFailures(scope: "login" | "mfa", subject: string): Promise<void> {
  await getSessionRedis().del(key(scope, subject));
}
