/**
 * @badabhai/db — Drizzle schema + client for BadaBhai's Supabase Postgres.
 *
 * - Schema/tables + row types: re-exported here and from "@badabhai/db/schema".
 * - Client: `createDbClient` (DI) / `getDb` (scripts).
 */
export * from "./schema";
export * from "./client";
export * from "./credit-packs";
