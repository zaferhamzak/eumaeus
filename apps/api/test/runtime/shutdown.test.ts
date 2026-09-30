import { describe, expect, it, vi } from "vitest";
import { createShutdownCoordinator } from "../../src/runtime/shutdown.js";
import { RuntimeState } from "../../src/runtime/state.js";
import type { Logger } from "../../src/logger.js";

function fakeLogger(): Logger {
  const noop = vi.fn();
  return { info: noop, error: noop, fatal: noop, warn: noop, debug: noop, trace: noop } as unknown as Logger;
}

describe("createShutdownCoordinator", () => {
  it("runs every step, in order, and marks the state draining then stopped", async () => {
    const state = new RuntimeState();
    state.markReady();
    const order: string[] = [];
    const coordinator = createShutdownCoordinator(
      [
        { name: "a", run: async () => { order.push("a"); } },
        { name: "b", run: async () => { order.push("b"); } },
        { name: "c", run: async () => { order.push("c"); } },
      ],
      { logger: fakeLogger(), state, gracePeriodMs: 1000 },
    );

    expect(state.get()).toBe("ready");
    const clean = await coordinator.run();
    expect(clean).toBe(true);
    expect(order).toEqual(["a", "b", "c"]);
    expect(state.get()).toBe("stopped");
  });

  it("is idempotent — calling run() twice (a second SIGTERM) does not re-execute the steps", async () => {
    const state = new RuntimeState();
    state.markReady();
    let callCount = 0;
    const coordinator = createShutdownCoordinator(
      [{ name: "only-once", run: async () => { callCount += 1; } }],
      { logger: fakeLogger(), state, gracePeriodMs: 1000 },
    );

    const [a, b] = await Promise.all([coordinator.run(), coordinator.run()]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(callCount).toBe(1);

    // A THIRD call, after the first two already resolved, must also not re-run it.
    await coordinator.run();
    expect(callCount).toBe(1);
  });

  it("a failing step is caught and logged, and later steps still run", async () => {
    const state = new RuntimeState();
    state.markReady();
    const order: string[] = [];
    const coordinator = createShutdownCoordinator(
      [
        { name: "fails", run: async () => { throw new Error("boom"); } },
        { name: "still-runs", run: async () => { order.push("still-runs"); } },
      ],
      { logger: fakeLogger(), state, gracePeriodMs: 1000 },
    );

    const clean = await coordinator.run();
    expect(clean).toBe(true); // the step failure itself doesn't count as exceeding the grace period
    expect(order).toEqual(["still-runs"]);
  });

  it("has a hard upper bound — a step that never resolves does not hang shutdown forever", async () => {
    const state = new RuntimeState();
    state.markReady();
    const coordinator = createShutdownCoordinator(
      [{ name: "hangs-forever", run: () => new Promise<void>(() => {}) }],
      { logger: fakeLogger(), state, gracePeriodMs: 50 },
    );

    const clean = await coordinator.run();
    expect(clean).toBe(false); // forced past the grace period
    expect(state.get()).toBe("stopped"); // still ends up stopped, not stuck in draining
  });

  it("runAndExit() calls exit(0) on a clean shutdown and exit(1) when the grace period was exceeded", async () => {
    const cleanState = new RuntimeState();
    cleanState.markReady();
    const cleanExit = vi.fn();
    const cleanCoordinator = createShutdownCoordinator([{ name: "fast", run: async () => {} }], {
      logger: fakeLogger(),
      state: cleanState,
      gracePeriodMs: 1000,
      exit: cleanExit,
    });
    await cleanCoordinator.runAndExit();
    expect(cleanExit).toHaveBeenCalledWith(0);

    const forcedState = new RuntimeState();
    forcedState.markReady();
    const forcedExit = vi.fn();
    const forcedCoordinator = createShutdownCoordinator([{ name: "hangs", run: () => new Promise<void>(() => {}) }], {
      logger: fakeLogger(),
      state: forcedState,
      gracePeriodMs: 20,
      exit: forcedExit,
    });
    await forcedCoordinator.runAndExit();
    expect(forcedExit).toHaveBeenCalledWith(1);
  });

  it("runAndExit(forcedCode) overrides the exit code even on a clean shutdown (uncaughtException/unhandledRejection semantics)", async () => {
    const state = new RuntimeState();
    state.markReady();
    const exit = vi.fn();
    const coordinator = createShutdownCoordinator([{ name: "fast", run: async () => {} }], {
      logger: fakeLogger(),
      state,
      gracePeriodMs: 1000,
      exit,
    });
    await coordinator.runAndExit(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
