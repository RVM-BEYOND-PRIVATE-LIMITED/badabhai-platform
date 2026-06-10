import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Database client (Drizzle + postgres.js).
 *
 * Prefer dependency injection: backend services should create one client at
 * startup (from validated config) and pass it around — see `createDbClient`.
 * `getDb()` is a lazy singleton convenience for scripts/seeds only.
 *
 * NOTE: the backend connects over a DIRECT Postgres connection as the `postgres`
 * role (Supabase session-pooler `postgres.<ref>` user), which has BYPASSRLS — NOT
 * the PostgREST `service_role` (Data API). RLS is enabled + deny-by-default on
 * `workers` (migrations 0003/0004); the `postgres` role bypasses it. The
 * connection string MUST therefore be a BYPASSRLS role (see infra/supabase/rls-plan.md).
 */
export interface DbClientOptions {
  /** postgres.js max pool size. */
  max?: number;
}

export function createDbClient(connectionString: string, options: DbClientOptions = {}) {
  if (!connectionString) {
    throw new Error("createDbClient: connectionString is required");
  }
  const sql = postgres(connectionString, { max: options.max ?? 10 });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

/** Full client handle: `{ db, sql }`. */
export type DbClient = ReturnType<typeof createDbClient>;
/** The Drizzle database instance type (use for DI / repository params). */
export type Database = DbClient["db"];

let _singleton: DbClient | undefined;

/**
 * Lazy singleton using `DATABASE_URL`. Intended for CLI scripts/seeds.
 * Application services should use DI via `createDbClient` instead.
 */
export function getDb() {
  if (!_singleton) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("getDb: DATABASE_URL is not set");
    _singleton = createDbClient(url);
  }
  return _singleton.db;
}
