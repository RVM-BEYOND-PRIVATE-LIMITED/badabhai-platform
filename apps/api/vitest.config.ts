import { defineConfig } from "vitest/config";

/**
 * Node-only vitest config for the NestJS API.
 * Uses the project's tsconfig and automatically finds test files.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "lcov"],
      reportsDirectory: "../../coverage/api",
      // Thresholds to prevent regression (TD9) — bumped 2026-07-25 as coverage rose.
      // Run `pnpm --filter @badabhai/api test -- --coverage` to refresh.
      thresholds: {
        lines: 75,
        functions: 75,
        branches: 73,
        statements: 75,
      },
      // Exclude non-testable layers from coverage
      exclude: [
        "src/main.ts",
        "src/**/*.dto.ts",
        "src/**/*.entity.ts",
        "src/**/*.interface.ts",
        "src/**/*.type.ts",
        "src/**/mock-*.ts",
        "**/*.test.ts",
        "**/*.spec.ts",
        "**/mocks/**",
      ],
    },
    // Increase timeout for integration tests
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});