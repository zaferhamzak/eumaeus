import type { Logger } from "../logger.js";
import type { RuntimeState } from "./state.js";

export interface ShutdownStep {
  name: string;
  run: () => Promise<void>;
}

export interface ShutdownCoordinatorOptions {
  logger: Logger;
  state: RuntimeState;
  /** Hard upper bound (ms) for the ENTIRE shutdown sequence — after this, the process exits regardless of what's still in-flight (Phase 7 §2: "shutdown must have a hard upper bound... after the grace period expires, process must terminate rather than hang forever"). */
  gracePeriodMs: number;
  /** Overridable only for tests — production code never passes this, so a real process.exit() happens. */
  exit?: (code: number) => void;
}

/**
 * One coordinated shutdown lifecycle, shared by both entrypoint processes
 * (worker.ts, server.ts) — each supplies its own ordered list of steps
 * (workers to close, Fastify to close, the scheduler, Redis, Prisma...).
 *
 * Idempotent (§2: "receiving SIGTERM twice must not execute shutdown twice"):
 * the SAME in-flight shutdown promise is returned to every caller after the
 * first — a second SIGINT/SIGTERM while draining does not start a second
 * shutdown sequence, it just awaits the one already running.
 *
 * Steps run SEQUENTIALLY, in the order supplied, and in that specific order
 * because later steps depend on earlier ones having stopped producing new
 * work first (e.g. "stop the scheduler" before "close the worker that would
 * otherwise pick up what the scheduler just produced"). A failing step is
 * logged and the sequence continues — one resource failing to close cleanly
 * must never prevent the others from at least being attempted.
 */
export function createShutdownCoordinator(steps: ShutdownStep[], options: ShutdownCoordinatorOptions) {
  const { logger, state, gracePeriodMs } = options;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  let shutdownPromise: Promise<boolean> | undefined;

  /** Resolves to `true` if every step completed within the grace period, `false` if the process was forced past it. */
  async function runSteps(): Promise<boolean> {
    state.markDraining();
    logger.info({ event: "shutdown_started", gracePeriodMs }, "shutdown initiated");

    let timedOut = false;
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, gracePeriodMs).unref();
    });

    const work = (async () => {
      for (const step of steps) {
        try {
          logger.info({ event: "shutdown_step_started", step: step.name }, `shutdown: ${step.name}`);
          await step.run();
          logger.info({ event: "shutdown_step_completed", step: step.name }, `shutdown: ${step.name} done`);
        } catch (error) {
          logger.error({ event: "shutdown_step_failed", step: step.name, err: error }, `shutdown: ${step.name} failed`);
        }
      }
    })();

    await Promise.race([work, timeout]);

    if (timedOut) {
      logger.error({ event: "shutdown_grace_period_exceeded", gracePeriodMs }, "shutdown grace period exceeded — forcing exit");
    } else {
      logger.info({ event: "shutdown_completed" }, "shutdown completed cleanly");
    }

    state.markStopped();
    return !timedOut;
  }

  /** Call from a signal handler. Returns the SAME promise on repeated calls (idempotent). Does not itself call process.exit() — see `runAndExit` for the version that does. */
  function run(): Promise<boolean> {
    shutdownPromise ??= runSteps();
    return shutdownPromise;
  }

  /**
   * What the real SIGTERM/SIGINT handlers register — runs shutdown, then
   * exits: code 0 if every step finished within the grace period, code 1 if
   * the grace period forced termination (§29: a forced/incomplete shutdown is
   * distinguishable from a clean one by exit code).
   *
   * `forcedExitCode`, when passed (uncaughtException/unhandledRejection
   * handlers pass 1), OVERRIDES the code even on a clean shutdown — the
   * trigger itself was fatal, so "the cleanup steps all completed" must never
   * present as a normal, healthy exit(0).
   */
  async function runAndExit(forcedExitCode?: number): Promise<void> {
    const cleanShutdown = await run();
    exit(forcedExitCode ?? (cleanShutdown ? 0 : 1));
  }

  return { run, runAndExit };
}
