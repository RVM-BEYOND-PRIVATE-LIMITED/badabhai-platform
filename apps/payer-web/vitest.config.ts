import { defineConfig } from "vitest/config";

export default defineConfig({
  // Use the automatic JSX runtime so .tsx tests render elements without `React` in
  // scope (the app uses `jsx: preserve` + Next's SWC transform; this only affects the
  // vitest/esbuild test transform, never Next's production build).
  esbuild: { jsx: "automatic" },
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    environment: "node",
    // `server-only` throws when imported outside a React Server Component build.
    // Alias it to a no-op so server-only seam modules (auth/roles, etc.) are unit
    // testable in the node env — it does NOT relax the build-time guarantee, which
    // still holds when Next compiles the app.
    alias: { "server-only": new URL("./test/server-only-stub.ts", import.meta.url).pathname },
  },
});
