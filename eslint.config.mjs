// Flat ESLint config for the whole TypeScript monorepo.
// Type-aware rules are intentionally NOT enabled to keep linting fast and
// independent of per-package tsconfig wiring. `pnpm typecheck` covers types.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/*.d.ts",
      // Non-pnpm workspaces have their own toolchains:
      "apps/ai-service/**",
      "apps/worker-app/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": "warn",
    },
  },
  {
    // Tests and config files may be looser.
    files: ["**/*.{test,spec}.{ts,tsx}", "**/*.config.{ts,mjs,js}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // NestJS relies on runtime class references in constructor parameter types
    // (emitDecoratorMetadata) for dependency injection. `consistent-type-imports`
    // would convert injected providers to `import type` and break DI at runtime,
    // so it is disabled for the API app.
    files: ["apps/api/**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "off",
    },
  },
);
