import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Persisted fixtures share the consumer registry and outbox. Concurrent
    // operations remain exercised within tests; files must not race cleanup.
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
