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
      // Thresholds to prevent regression (TD9) — set to current baseline
      // Current: lines 74.12%, functions 74.21%, branches 73.x%, statements 74.12%
      thresholds: {
        lines: 74,
        functions: 74,
        branches: 73,
        statements: 74,
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