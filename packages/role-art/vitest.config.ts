import { defineConfig } from "vitest/config";

export default defineConfig({
  // Automatic JSX runtime for the .tsx tests — the same transform both apps' vitest configs
  // apply, so a test here renders the component exactly as the apps' tests do.
  esbuild: { jsx: "automatic" },
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    environment: "node",
  },
});
