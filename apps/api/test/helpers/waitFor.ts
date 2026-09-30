/** Polls `check` until it returns true or `timeoutMs` elapses. Used for asserting on background BullMQ job effects without a flaky fixed sleep. */
export async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}
