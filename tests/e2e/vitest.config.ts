import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `*.static.test.ts`: source checks that need no API or DB (e2e-phone-slots.static.test.ts).
    include: ["**/*.e2e.test.ts", "**/*.static.test.ts"],
    // The flow makes several network round-trips against a live API + DB.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Steps share state and must run in order, in a single worker.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
