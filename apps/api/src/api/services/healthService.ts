import { prisma } from "../../db/client.js";
import { getRedisConnection } from "../../queue/connection.js";
import type { RuntimeState } from "../../runtime/state.js";
import { readWorkerStatus, type WorkerStatus } from "../../runtime/workerHeartbeat.js";

export type CheckStatus = "ok" | "error";

export interface ReadinessResult {
  status: CheckStatus;
  checks: { database: CheckStatus; redis: CheckStatus; runtime: CheckStatus };
  runtimeState: string;
  /**
   * The background worker (sync, analysis, actions, alerts), from its
   * heartbeat. Reported but NOT part of `status`: this API instance can serve
   * requests without it, and a readiness probe must not pull the API out of
   * rotation because another process is down.
   */
  worker: WorkerStatus;
}

async function checkDatabase(): Promise<CheckStatus> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return "ok";
  } catch {
    return "error";
  }
}

async function checkRedis(): Promise<CheckStatus> {
  try {
    const result = await getRedisConnection().ping();
    return result === "PONG" ? "ok" : "error";
  } catch {
    return "error";
  }
}

/** GET /api/v1/health — is the API process itself alive. No dependency checks, and NOT gated on runtime state: a draining instance is still alive and must keep answering this (a container orchestrator's liveness probe failing during a graceful drain would cause it to SIGKILL the very process trying to shut down cleanly). Deliberately never fails merely because Postgres/Redis is temporarily unavailable. */
export function checkLiveness(): { status: "ok" } {
  return { status: "ok" };
}

/**
 * GET /api/v1/ready — can this instance safely accept new work right now.
 * Three independent checks, ALL required for `status: "ok"` (§7/§8/§24):
 *   - runtime: is the process in the `ready` state (not `starting`, `draining`,
 *     or `stopped`)? A drain must flip this to "error" immediately —
 *     independent of whether Postgres/Redis themselves are still reachable.
 *   - database / redis: the same Phase 6 dependency checks, unchanged — never
 *     individual mailboxes, webhook destinations, or Jev API availability.
 * Database/Redis are still checked even while draining (cheap, and honestly
 * informative — "we're draining AND the database just went down" is a
 * meaningfully different situation from "we're draining and everything else
 * is fine"), but the runtime check alone is enough to fail `status`.
 */
export async function checkReadiness(state: RuntimeState): Promise<ReadinessResult> {
  const runtimeStateValue = state.get();
  const runtime: CheckStatus = state.isAcceptingWork() ? "ok" : "error";

  const [database, redis, worker] = await Promise.all([checkDatabase(), checkRedis(), readWorkerStatus(getRedisConnection())]);
  const status: CheckStatus = runtime === "ok" && database === "ok" && redis === "ok" ? "ok" : "error";
  return { status, checks: { database, redis, runtime }, runtimeState: runtimeStateValue, worker };
}
