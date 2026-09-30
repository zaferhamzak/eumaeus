/**
 * Container health check for the worker: healthy while its heartbeat
 * (runtime/workerHeartbeat.ts) is fresh in Redis. Exit 0 = healthy.
 * Reads only REDIS_URL, so it doesn't need the rest of the configuration.
 */
import { Redis } from "ioredis";
import { WORKER_HEARTBEAT_KEY } from "../runtime/workerHeartbeat.js";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1, connectTimeout: 3000, lazyConnect: true });
try {
  await redis.connect();
  const beat = await redis.get(WORKER_HEARTBEAT_KEY);
  process.exitCode = beat ? 0 : 1;
} catch {
  process.exitCode = 1;
} finally {
  redis.disconnect();
}
