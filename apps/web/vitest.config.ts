import { defineConfig } from "vitest/config";

/**
 * Node-only vitest config for the ops console. Deliberately NO jsdom / RTL — the
 * only tests here cover PURE response → view-state mapping functions
 * (`src/lib/unlock-view.ts`), which are the security-load-bearing no-oracle logic.
 * Keeping the environment to "node" avoids scaffolding a full DOM test stack.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
