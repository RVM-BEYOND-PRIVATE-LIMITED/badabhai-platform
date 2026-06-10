import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Load the repo-root .env (drizzle-kit runs with CWD = packages/db, so plain
// "dotenv/config" would look for a non-existent packages/db/.env and silently
// fall back to the localhost default). Root .env's DATABASE_URL must have any
// special characters in the password percent-encoded (e.g. @ -> %40).
config({ path: "../../.env" });

/**
 * Drizzle Kit config. Used by:
 *   pnpm db:generate  -> diffs schema.ts into ./migrations/*.sql (no DB needed)
 *   pnpm db:migrate   -> applies migrations to DATABASE_URL
 *   pnpm db:studio    -> opens Drizzle Studio
 *
 * For Supabase, set DATABASE_URL to the project's connection string. See
 * infra/supabase/local-dev.md.
 */
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://badabhai:badabhai@localhost:5432/badabhai",
  },
  verbose: true,
  strict: true,
});
