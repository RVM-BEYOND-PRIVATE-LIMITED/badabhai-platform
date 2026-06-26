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
      // Claude Code harness (hooks/config/docs) — not application source.
      ".claude/**",
      // Design-system REFERENCE material (browser-global JSX/JS demos, templates,
      // ui_kits) — not application source; it has its own `_adherence.oxlintrc.json`
      // and is consumed by porting, not by linting it as repo source.
      "docs/design/**",
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
  {
    // Standalone Node ESM scripts (operational tooling, e.g. the staging smoke):
    // give them the Node global environment so `process`/`console`/`fetch` etc.
    // are recognized (they run under `node`, not the TS build).
    files: ["scripts/**/*.{mjs,js}"],
    languageOptions: {
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        fetch: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        Buffer: "readonly",
      },
    },
  },
  {
    // DESIGN-SYSTEM ADHERENCE (DS4.3) — payer-web is built entirely from the BadaBhai
    // design tokens. Raw hex colors and raw `px` sizes in the UI source are a regression:
    // they don't flow through the token layer and don't flip under [data-theme="ink"].
    // These two rules are lifted from the design system's `_adherence.oxlintrc.json`
    // (which is ESLint `no-restricted-syntax` syntax) and run here under the repo's
    // ESLint — oxlint itself does NOT implement `no-restricted-syntax`, so ESLint is the
    // enforcer (the existing `pnpm lint` / CI Lint step gates it); oxlint runs separately
    // as a fast supplementary lint. The component prop-restriction selectors from that
    // config are intentionally NOT enabled — the DS primitives extend HTMLAttributes and
    // legitimately forward `id`/`aria-*`/`onClick`/`value`/… via `...rest`, which those
    // selectors would false-positive on. Color/size token *values* live in CSS, so the
    // token files + the `.bb-*` component CSS (the design-system source of truth) are out
    // of scope here (ESLint lints TS/TSX only).
    files: ["apps/payer-web/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/#[0-9a-fA-F]{3,8}\\b/]",
          message: "Raw hex color — use a design-system color token via var() (DS adherence).",
        },
        {
          selector: "Literal[value=/\\b\\d+px\\b/]",
          message: "Raw px value — use a design-system spacing/size token via var() (DS adherence).",
        },
      ],
    },
  },
  {
    // Tests + the DS stories harness legitimately reference raw hex/px in assertions
    // (e.g. matching `#E0371C` / `width:52px` in rendered output) — the adherence gate
    // applies to SHIPPED UI source, not the checks that police it.
    files: [
      "apps/payer-web/**/*.{test,spec}.{ts,tsx}",
      "apps/payer-web/**/*.stories.{ts,tsx}",
    ],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
);
