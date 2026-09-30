import type { Redis } from "ioredis";

/**
 * The worker process says "alive" in Redis every HEARTBEAT_EVERY_MS; the key
 * expires after HEARTBEAT_TTL_S. The API reads it for /ready and the UI, so a
 * worker that died (or never started) is visible instead of silent — every
 * background job, including the operational alerts, runs in the worker, so
 * nothing else would notice.
 */
export const WORKER_HEARTBEAT_KEY = "eumaeus:worker:heartbeat";
export const HEARTBEAT_EVERY_MS = 20_000;
export const HEARTBEAT_TTL_S = 60;

export function startWorkerHeartbeat(redis: Redis, onError: (error: unknown) => void): () => Promise<void> {
  const beat = () => redis.set(WORKER_HEARTBEAT_KEY, JSON.stringify({ at: new Date().toISOString(), pid: process.pid }), "EX", HEARTBEAT_TTL_S).catch(onError);
  void beat();
  const timer = setInterval(() => void beat(), HEARTBEAT_EVERY_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    // A clean shutdown says so at once instead of waiting for the key to expire.
    await redis.del(WORKER_HEARTBEAT_KEY).catch(onError);
  };
}

export interface WorkerStatus {
  status: "ok" | "down";
  /** When the last heartbeat was written (null = none within the TTL). */
  lastSeenAt: string | null;
}

export async function readWorkerStatus(redis: Redis): Promise<WorkerStatus> {
  try {
    const raw = await redis.get(WORKER_HEARTBEAT_KEY);
    if (!raw) return { status: "down", lastSeenAt: null };
    const at = (JSON.parse(raw) as { at?: string }).at ?? null;
    return { status: "ok", lastSeenAt: at };
  } catch {
    return { status: "down", lastSeenAt: null };
  }
}

/**
 * imapflow can reject a promise nobody awaits when a connection drops while
 * it sets a session up on its own (seen: COMPRESS / ENABLE after a socket
 * timeout). The sync that owned the connection already fails and records it;
 * this leftover must not take the whole worker down. Only errors that carry
 * imapflow's connection id qualify — anything else stays fatal. imapflow
 * stamps it as `_connId` on socket errors and as `cid` on the errors it
 * builds itself ("Connection not available" and friends, 1.7+); missing the
 * second kind let a connection that dropped as the Mac went to sleep stop
 * the worker for the rest of the night.
 */
export function isImapConnectionLeftover(reason: unknown): boolean {
  if (!reason || typeof reason !== "object") return false;
  const e = reason as { _connId?: unknown; cid?: unknown; code?: unknown };
  return (typeof e._connId === "string" || typeof e.cid === "string") && typeof e.code === "string";
}
