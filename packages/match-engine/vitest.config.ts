import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The release-gate suite is the deliverable: keep it fast and deterministic.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
