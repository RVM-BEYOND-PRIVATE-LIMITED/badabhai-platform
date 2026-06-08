import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.e2e.test.ts"],
    // The flow makes several network round-trips against a live API + DB.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Steps share state and must run in order, in a single worker.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
