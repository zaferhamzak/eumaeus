/**
 * The whole runtime state machine Phase 7 needs (brief §8: "do not create a
 * complicated state machine") — four states, one direction of travel:
 *
 *   starting -> ready -> draining -> stopped
 *
 * There is no going back from `draining` to `ready`: once a shutdown signal is
 * received, the only way out is finishing it. Each of the two entrypoint
 * processes (worker.ts, server.ts) owns exactly one RuntimeState instance —
 * this is deliberately per-process module state, not a shared/distributed
 * concept (there is nothing to coordinate across processes: each process
 * drains its own work independently).
 */
export type RuntimeStateValue = "starting" | "ready" | "draining" | "stopped";

export class RuntimeState {
  private value: RuntimeStateValue = "starting";

  get(): RuntimeStateValue {
    return this.value;
  }

  markReady(): void {
    if (this.value === "starting") this.value = "ready";
  }

  /** Idempotent — calling this more than once (e.g. a second SIGTERM) is a no-op from the state's point of view; the shutdown coordinator (runtime/shutdown.ts) is what actually guards against running shutdown twice, this just makes the state itself safe to re-set. */
  markDraining(): void {
    if (this.value !== "stopped") this.value = "draining";
  }

  markStopped(): void {
    this.value = "stopped";
  }

  /** Can this instance safely accept new work (an HTTP request, a new job)? Only `ready` — not `starting` (dependencies unverified yet) and not `draining`/`stopped` (shutting down). */
  isAcceptingWork(): boolean {
    return this.value === "ready";
  }
}
