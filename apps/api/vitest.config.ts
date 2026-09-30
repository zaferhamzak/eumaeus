import { defineConfig } from "vitest/config";

// Load .env for the test process (Node's built-in loader — no dotenv dependency).
// Falls back silently if .env doesn't exist, e.g. in CI where env vars are injected
// directly by the runner.
try {
  process.loadEnvFile(new URL("./.env", import.meta.url));
} catch {
  // no .env present — assume the environment already has what's needed
}

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 15000,
    hookTimeout: 30000,
    // Integration tests share one Postgres database and must not run their
    // beforeEach/reset logic concurrently against it.
    fileParallelism: false,
  },
});
