import { createHash, randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { loadEnv } from "../../config/env.js";
import { getSystemSettings } from "../settings/systemSettings.js";

/**
 * A SECOND, dedicated ioredis client — deliberately not
 * queue/connection.ts's shared BullMQ connection. `maxRetriesPerRequest:
 * null` there is a BullMQ-specific requirement (it does its own
 * retry/backoff bookkeeping); session reads/writes are ordinary short-lived
 * Redis calls and should behave like normal ioredis defaults instead.
 */
let connection: Redis | undefined;

export function getSessionRedis(): Redis {
  if (!connection) {
    connection = new Redis(loadEnv().REDIS_URL);
  }
  return connection;
}

/** Phase 11 shutdown step — mirrors queue/connection.ts's closeRedisConnection() exactly, a no-op if never opened. */
export async function closeSessionRedisConnection(): Promise<void> {
  if (!connection) return;
  await connection.quit();
  connection = undefined;
}

export interface SessionMeta {
  ip?: string;
  userAgent?: string;
}

interface SessionData extends SessionMeta {
  userId: string;
  createdAt: string;
  lastSeenAt: string;
}

const SESSION_KEY_PREFIX = "session:";
/** Per-user index of live session tokens (a Redis set) — what makes "list my sessions", "sign out that device", and "sign out everywhere after a password change" possible without scanning every session:* key. Entries whose session key has already expired are pruned lazily on read. */
const USER_SESSIONS_KEY_PREFIX = "user_sessions:";
const MFA_PENDING_KEY_PREFIX = "mfa_pending:";
/** Fixed, short TTL for the intermediate "passed password, not MFA yet" state — deliberately NOT configurable and much shorter than SESSION_TTL_SECONDS, since this token grants nothing on its own beyond "may attempt one TOTP verification." */
const MFA_PENDING_TTL_SECONDS = 300;
/** lastSeenAt is rewritten at most this often per session — refreshing on every single request would double Redis writes for no user-visible benefit. */
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

function newOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The PUBLIC identifier for a session — a hash of the token, never the token
 * itself. The token is the credential (it's the cookie value); exposing it
 * in a "your sessions" list would hand anyone who can read that list a way
 * to impersonate the session.
 */
export function publicSessionId(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/** Creates a full session, returning the opaque token that becomes the cookie value. The Redis key is the ONLY place the (userId, session) link lives — the cookie itself carries no meaning on its own. */
export async function createSession(userId: string, meta: SessionMeta = {}): Promise<string> {
  const token = newOpaqueToken();
  const now = new Date().toISOString();
  const data: SessionData = { userId, createdAt: now, lastSeenAt: now, ip: meta.ip, userAgent: meta.userAgent };
  const settings = await getSystemSettings();
  await getSessionRedis()
    .multi()
    .set(SESSION_KEY_PREFIX + token, JSON.stringify(data), "EX", settings.sessionTtlSeconds)
    .sadd(USER_SESSIONS_KEY_PREFIX + userId, token)
    .exec();
  return token;
}

export async function readSession(token: string): Promise<SessionData | null> {
  const raw = await getSessionRedis().get(SESSION_KEY_PREFIX + token);
  if (!raw) return null;
  return JSON.parse(raw) as SessionData;
}

/** Sliding expiration — called once per authenticated request (authContext.ts) so an idle session eventually expires but an active one never does mid-use. Also bumps lastSeenAt, throttled. getSystemSettings() is cached in-process (30s), so this does not mean a DB round-trip per request. */
export async function refreshSession(token: string, session?: SessionData): Promise<void> {
  const settings = await getSystemSettings();
  if (session && Date.now() - Date.parse(session.lastSeenAt) > LAST_SEEN_WRITE_INTERVAL_MS) {
    const updated: SessionData = { ...session, lastSeenAt: new Date().toISOString() };
    await getSessionRedis().set(SESSION_KEY_PREFIX + token, JSON.stringify(updated), "EX", settings.sessionTtlSeconds);
    return;
  }
  await getSessionRedis().expire(SESSION_KEY_PREFIX + token, settings.sessionTtlSeconds);
}

export async function deleteSession(token: string): Promise<void> {
  const session = await readSession(token);
  const tx = getSessionRedis().multi().del(SESSION_KEY_PREFIX + token);
  if (session) tx.srem(USER_SESSIONS_KEY_PREFIX + session.userId, token);
  await tx.exec();
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export async function listUserSessions(userId: string, currentToken?: string): Promise<SessionSummary[]> {
  const redis = getSessionRedis();
  const tokens = await redis.smembers(USER_SESSIONS_KEY_PREFIX + userId);
  const summaries: SessionSummary[] = [];
  for (const token of tokens) {
    const session = await readSession(token);
    if (!session) {
      await redis.srem(USER_SESSIONS_KEY_PREFIX + userId, token); // expired — prune the index
      continue;
    }
    summaries.push({
      id: publicSessionId(token),
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      ip: session.ip ?? null,
      userAgent: session.userAgent ?? null,
      current: token === currentToken,
    });
  }
  return summaries.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

/** Revokes one of the user's OWN sessions by its public id. Returns false if no such session belongs to this user — a user can never reach another user's session this way, since only their own index is searched. */
export async function deleteUserSessionById(userId: string, sessionId: string): Promise<boolean> {
  const tokens = await getSessionRedis().smembers(USER_SESSIONS_KEY_PREFIX + userId);
  const token = tokens.find((t) => publicSessionId(t) === sessionId);
  if (!token) return false;
  await deleteSession(token);
  return true;
}

/** Signs a user out everywhere, optionally keeping one session (the one making the request). Used after a password change and by "sign out other sessions". Returns how many were revoked. */
export async function deleteAllUserSessions(userId: string, exceptToken?: string): Promise<number> {
  const tokens = await getSessionRedis().smembers(USER_SESSIONS_KEY_PREFIX + userId);
  let revoked = 0;
  for (const token of tokens) {
    if (token === exceptToken) continue;
    await deleteSession(token);
    revoked += 1;
  }
  return revoked;
}

/**
 * The intermediate state between "password verified" and "fully logged in"
 * for an MFA-enabled user. A SEPARATE Redis key namespace from session:* —
 * never promoted into a session key by renaming/relaxing its TTL. On success
 * (POST /auth/login/mfa) the caller creates a brand-new session via
 * createSession() and calls consumeMfaPendingToken() to delete this one; on
 * its own this token grants no API access.
 */
export async function createMfaPendingToken(userId: string): Promise<string> {
  const token = newOpaqueToken();
  await getSessionRedis().set(MFA_PENDING_KEY_PREFIX + token, userId, "EX", MFA_PENDING_TTL_SECONDS);
  return token;
}

export async function readMfaPendingToken(token: string): Promise<string | null> {
  return getSessionRedis().get(MFA_PENDING_KEY_PREFIX + token);
}

/** Deletes the pending token — called on success so a leaked/reused token can never be replayed after a completed MFA verification. */
export async function consumeMfaPendingToken(token: string): Promise<void> {
  await getSessionRedis().del(MFA_PENDING_KEY_PREFIX + token);
}
