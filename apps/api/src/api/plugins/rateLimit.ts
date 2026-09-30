import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { RateLimitedError } from "../errors/ApiError.js";
import { logger } from "../../logger.js";

/*
 * 1.0: the limits are enforced across ALL API replicas via Redis (below,
 * RedisFixedWindowLimiter) — the in-process limiter described next remains
 * as the test store and as the fallback while Redis is unreachable (a Redis
 * outage degrades to per-replica limits, it never blocks every request).
 */

/**
 * A deliberately simple, IN-PROCESS, fixed-window limiter (Phase 7 §13: "do NOT
 * implement sophisticated distributed rate limiting unless required"). Keyed by
 * client IP — there is no API-key/auth concept yet (out of scope for this
 * phase) to key on instead.
 *
 * IMPORTANT, explicitly documented per §13's own instruction: this limiter's
 * state lives in ONE process's memory. If Eumaeus's API is ever run as more
 * than one replica behind a load balancer, EACH replica enforces this limit
 * independently — a client could receive up to (replica count × max) requests
 * in a window before any single replica's view of "too many" is accurate. This
 * is a known, accepted limitation of a single-process deployment, not a bug;
 * a horizontally-scaled deployment needs a shared store (e.g. Redis, which
 * this repo already depends on for BullMQ) for a real distributed limiter —
 * deliberately NOT built here, since nothing in the current deployment model
 * requires it yet (§34: do not overengineer).
 */
interface Limiter {
  check(key: string): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

class FixedWindowLimiter implements Limiter {
  private windowStartMs = new Map<string, number>();
  private count = new Map<string, number>();
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {
    // §31 "unbounded arrays": without this, a unique key (client IP) is added
    // to these Maps the first time it's ever seen and NEVER removed — over a
    // long-running process's lifetime, that's an unbounded-growth memory leak
    // keyed by however many distinct IPs ever made a request. Periodically
    // dropping entries whose window has fully expired keeps memory
    // proportional to RECENTLY ACTIVE clients only. Swept at 4x the window
    // (not more often — no need to scan on every request) and unref()'d so it
    // never keeps the process alive on its own (a real concern for graceful
    // shutdown — an active timer handle is exactly the kind of thing that
    // would otherwise stop Node from exiting cleanly).
    this.sweepTimer = setInterval(() => this.sweep(), this.windowMs * 4);
    this.sweepTimer.unref();
  }

  async check(key: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    return this.checkSync(key);
  }

  checkSync(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    const start = this.windowStartMs.get(key);
    if (start === undefined || now - start >= this.windowMs) {
      this.windowStartMs.set(key, now);
      this.count.set(key, 1);
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const current = (this.count.get(key) ?? 0) + 1;
    this.count.set(key, current);
    if (current > this.max) {
      return { allowed: false, retryAfterSeconds: Math.ceil((this.windowMs - (now - start)) / 1000) };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, start] of this.windowStartMs) {
      if (now - start >= this.windowMs) {
        this.windowStartMs.delete(key);
        this.count.delete(key);
      }
    }
  }

  /** Test-only: stop the sweep timer so a test doesn't leak a live interval handle past its own lifetime. */
  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }
}

/**
 * Fixed windows shared by every replica: one counter per (limit, client,
 * window) in Redis, created with the window's lifetime. Falls back to the
 * in-process limiter if Redis errors (logged once per outage).
 */
class RedisFixedWindowLimiter implements Limiter {
  private readonly fallback: FixedWindowLimiter;
  private degraded = false;

  constructor(
    private readonly redis: Redis,
    private readonly name: string,
    private readonly windowMs: number,
    private readonly max: number,
  ) {
    this.fallback = new FixedWindowLimiter(windowMs, max);
  }

  async check(key: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const now = Date.now();
    const windowIndex = Math.floor(now / this.windowMs);
    const redisKey = `eumaeus:rl:${this.name}:${key}:${windowIndex}`;
    try {
      const result = await this.redis.multi().incr(redisKey).pexpire(redisKey, this.windowMs, "NX").exec();
      const count = Number(result?.[0]?.[1] ?? 0);
      if (this.degraded) {
        this.degraded = false;
        logger.info({ event: "rate_limit_redis_restored" }, "rate limiting is shared across replicas again");
      }
      if (count > this.max) {
        const windowEnd = (windowIndex + 1) * this.windowMs;
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((windowEnd - now) / 1000)) };
      }
      return { allowed: true, retryAfterSeconds: 0 };
    } catch (error) {
      if (!this.degraded) {
        this.degraded = true;
        logger.warn({ event: "rate_limit_redis_unavailable", err: error }, "rate limiting falls back to this replica only");
      }
      return this.fallback.checkSync(key);
    }
  }
}

export interface RateLimitRule {
  windowMs: number;
  max: number;
}

export interface RateLimitConfig {
  /** Applied to every request in scope. */
  global: RateLimitRule;
  /** Stricter, additional limits for specific (method, route-template) pairs — checked IN ADDITION to the global limit, not instead of it. Route template as Fastify registers it (e.g. "/api/v1/action-executions/:id/retry"), not the resolved URL. */
  routes?: Record<string, RateLimitRule>;
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  global: { windowMs: 60_000, max: 300 },
  routes: {
    "POST /api/v1/action-executions/:id/retry": { windowMs: 60_000, max: 20 },
    "POST /api/v1/mailboxes/:id/reconcile": { windowMs: 60_000, max: 10 },
  },
};

export function registerRateLimitPlugin(app: FastifyInstance, config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG, redis?: Redis): void {
  const make = (name: string, rule: RateLimitRule): Limiter => (redis ? new RedisFixedWindowLimiter(redis, name, rule.windowMs, rule.max) : new FixedWindowLimiter(rule.windowMs, rule.max));
  const globalLimiter = make("global", config.global);
  const routeLimiters = new Map<string, Limiter>();
  for (const [key, rule] of Object.entries(config.routes ?? {})) {
    routeLimiters.set(key, make(key.replace(/[^A-Za-z0-9/:_-]/g, "_"), rule));
  }

  // Global check in onRequest — the earliest hook, runs before body parsing,
  // and needs no routing information.
  app.addHook("onRequest", async (request) => {
    const global = await globalLimiter.check(request.ip);
    if (!global.allowed) {
      throw new RateLimitedError("Too many requests — global rate limit exceeded", global.retryAfterSeconds);
    }
  });

  // Route-specific check in preHandler — by this point Fastify has fully
  // matched the route, so `request.routeOptions.url` is the route TEMPLATE
  // (e.g. "/api/v1/action-executions/:id/retry"), not the resolved URL with a
  // real id in it (onRequest does not reliably have this populated yet).
  app.addHook("preHandler", async (request) => {
    const routeKey = `${request.method} ${request.routeOptions?.url ?? ""}`;
    const routeLimiter = routeLimiters.get(routeKey);
    if (!routeLimiter) return;
    const result = await routeLimiter.check(request.ip);
    if (!result.allowed) {
      throw new RateLimitedError(`Too many requests to ${routeKey} — endpoint-specific rate limit exceeded`, result.retryAfterSeconds);
    }
  });
}
