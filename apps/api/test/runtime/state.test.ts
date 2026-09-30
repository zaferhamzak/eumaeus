import { describe, expect, it } from "vitest";
import { RuntimeState } from "../../src/runtime/state.js";

describe("RuntimeState", () => {
  it("starts in 'starting' and does not accept work yet", () => {
    const state = new RuntimeState();
    expect(state.get()).toBe("starting");
    expect(state.isAcceptingWork()).toBe(false);
  });

  it("markReady() moves starting -> ready, and only accepts work in that state", () => {
    const state = new RuntimeState();
    state.markReady();
    expect(state.get()).toBe("ready");
    expect(state.isAcceptingWork()).toBe(true);
  });

  it("markDraining() moves ready -> draining, and stops accepting work", () => {
    const state = new RuntimeState();
    state.markReady();
    state.markDraining();
    expect(state.get()).toBe("draining");
    expect(state.isAcceptingWork()).toBe(false);
  });

  it("markStopped() moves draining -> stopped", () => {
    const state = new RuntimeState();
    state.markReady();
    state.markDraining();
    state.markStopped();
    expect(state.get()).toBe("stopped");
    expect(state.isAcceptingWork()).toBe(false);
  });

  it("there is no way back from draining to ready — markReady() after draining is a no-op", () => {
    const state = new RuntimeState();
    state.markReady();
    state.markDraining();
    state.markReady();
    expect(state.get()).toBe("draining");
  });

  it("markDraining() is idempotent — calling it twice (e.g. a second SIGTERM) does not change or error", () => {
    const state = new RuntimeState();
    state.markReady();
    state.markDraining();
    expect(() => state.markDraining()).not.toThrow();
    expect(state.get()).toBe("draining");
  });

  it("markDraining() after stopped does not resurrect the state", () => {
    const state = new RuntimeState();
    state.markReady();
    state.markDraining();
    state.markStopped();
    state.markDraining();
    expect(state.get()).toBe("stopped");
  });
});
