import { defineConfig } from "vitest/config";

/**
 * Node-only vitest config, same pattern as apps/web and apps/payer-web: the page is a
 * static Server Component with zero hooks, so it renders via `react-dom/server` in plain
 * "node" — no jsdom / RTL needed for this surface.
 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
