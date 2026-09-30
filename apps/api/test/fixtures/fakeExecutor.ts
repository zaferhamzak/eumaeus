import type { DestinationExecutor, ExecutionOutcome } from "../../src/modules/destinations/executors/types.js";

/** A controllable, call-counting DestinationExecutor stand-in — used wherever a test needs to observe/limit how many times execution was actually attempted, independent of the real Archive/IMAP machinery. */
export function createFakeExecutor(outcomes: ExecutionOutcome[], delayMs = 0): DestinationExecutor & { callCount: number } {
  let index = 0;
  const state = {
    channelType: "archive",
    callCount: 0,
    async execute(): Promise<ExecutionOutcome> {
      state.callCount += 1;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const outcome = outcomes[index];
      index += 1;
      if (!outcome) throw new Error("createFakeExecutor: ran out of configured outcomes");
      return outcome;
    },
  };
  return state;
}

export function executorThatMustNotBeCalled(): DestinationExecutor {
  return {
    channelType: "archive",
    async execute(): Promise<ExecutionOutcome> {
      throw new Error("executor was called, but this test asserts it must not be — idempotency check failed to short-circuit");
    },
  };
}
