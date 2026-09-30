import { Redis } from "ioredis";
import { loadEnv } from "../config/env.js";

let connection: Redis | undefined;

/**
 * Shared Redis connection for BullMQ. `maxRetriesPerRequest: null` is required by
 * BullMQ (it does its own retry/backoff bookkeeping on top of the raw connection).
 */
export function getRedisConnection(): Redis {
  if (!connection) {
    const env = loadEnv();
    connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  }
  return connection;
}

/**
 * Phase 7 shutdown step (§2/§27): closes the shared ioredis connection every
 * Queue/Worker in this process was constructed with. Must run AFTER every
 * BullMQ Worker's own `.close()` has completed — closing the underlying
 * connection first would make a Worker's own graceful drain (finishing its
 * active job) impossible. A no-op if the connection was never opened (a
 * process that never touched Redis, e.g. a test that never called any queue
 * function).
 */
export async function closeRedisConnection(): Promise<void> {
  if (!connection) return;
  await connection.quit();
  connection = undefined;
}
