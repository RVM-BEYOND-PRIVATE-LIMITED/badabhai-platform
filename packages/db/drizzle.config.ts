import "dotenv/config";
import { defineConfig } from "drizzle-kit";

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
