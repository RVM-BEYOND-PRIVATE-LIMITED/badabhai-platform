import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, schema, type DbClient } from "@badabhai/db";

/**
 * Spine-wide RLS + REVOKE regression (TD20).
 *
 * Proves the platform-wide PII/linkage lock: every application table denies the
 * PostgREST Data-API roles (anon / authenticated / service_role), so `worker_id`,
 * correlation ids, and the encrypted-PII linkage are unreachable with a Supabase
 * client key. `workers` was locked in 0003/0004; the next 13 in 0009; `jobs` +
 * `applications` in 0012 (created and locked in the same migration, ADR-0009).
 *
 * Two things make this a real guarantee (not a SELECT-only smoke test):
 *  1. NO-DRIFT: the static list below is reconciled against the LIVE public schema
 *     (`pg_tables`) AND the `schema` model count — so a new pgTable that ships without
 *     a lock FAILS this suite instead of being silently skipped by a stale list.
 *  2. REVOKE *ALL*: we assert `has_table_privilege` is false for SELECT *and*
 *     INSERT/UPDATE/DELETE — a table that revoked only SELECT but kept a write grant
 *     would pass a SELECT-only test; it fails here.
 * Plus a runtime cross-check (SET ROLE -> SELECT -> 42501) that a revoked grant yields
 * a real denial, and a backend-can-still-read sanity so the lock never breaks the app.
 *
 * DB-only (no API needed). Opt-in like the other e2e:
 *   1. docker compose up -d postgres
 *   2. create the Supabase-compatible roles (anon/authenticated/service_role)
 *   3. pnpm db:migrate
 *   4. RUN_E2E=1 pnpm --filter @badabhai/e2e test
 * CI does all of this in the `e2e` job (it pre-creates the roles + migrates).
 */

const RUN = process.env.RUN_E2E === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

// Drives the per-(role,table) cases (must be known synchronously at collect time).
// The "no drift vs the live schema" test below makes this list self-policing.
const LOCKED_TABLES = [
  "workers",
  "payers", // ADR-0019: payer/employer B2B PII (new class); RLS+FORCE+REVOKE in migration 0020
  "worker_consents",
  "worker_profiles",
  "chat_sessions",
  "voice_notes",
  "chat_messages",
  "generated_resumes",
  "events",
  "ai_jobs",
  "audit_logs",
  "profiles",
  "questions",
  "profile_questions",
  "worker_answers",
  "jobs",
  "applications",
  "unlocks",
  "payer_credits",
  "credit_ledger",
  "unlock_routing",
  "job_postings",
  "pricing_catalog",
  "posting_plans",
  "posting_boosts",
  "resume_disclosures",
  "payer_capacity",
  "invites", // ADR-0020: WhatsApp invite funnel (PII-free); RLS+FORCE+REVOKE in migration 0021
  "pace_states", // ADR-0021: pace supply-widening state (PII-free); RLS+FORCE+REVOKE in migration 0023
] as const;

// The three network-reachable PostgREST roles Supabase ships.
const CLIENT_ROLES = ["anon", "authenticated", "service_role"] as const;
// REVOKE ALL must strip every DML privilege, not just SELECT.
const DML = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

describe.skipIf(!RUN)("Spine RLS + REVOKE — every table denies the Data-API roles (TD20)", () => {
  let client!: DbClient;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);

    // Guard the signal: a missing/misconfigured client role must fail LOUDLY here, not
    // surface as a confusing per-table error. (We intentionally do NOT assert
    // !rolbypassrls — Supabase's service_role legitimately has BYPASSRLS; REVOKE still
    // denies it, since BYPASSRLS skips RLS policies, not table grants.)
    for (const role of CLIENT_ROLES) {
      const rows = await client.sql.unsafe(
        `SELECT rolsuper FROM pg_roles WHERE rolname = '${role}'`,
      );
      expect(rows.length, `client role "${role}" must exist`).toBe(1);
      expect(rows[0]!.rolsuper, `client role "${role}" must not be superuser`).toBe(false);
    }
  });

  afterAll(async () => {
    await client?.sql.end({ timeout: 5 });
  });

  // No-drift: the locked-table list must equal the LIVE set of public tables AND the
  // `schema` model. A future table added without being locked + listed fails here.
  it("LOCKED_TABLES matches the live public schema and the model (no drift)", async () => {
    const rows = await client.sql.unsafe(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const live = new Set(rows.map((r) => r.tablename as string));
    expect(new Set(LOCKED_TABLES)).toEqual(live); // every public table is covered, none extra
    expect(live.size).toBe(Object.keys(schema).length); // and the DB matches the Drizzle model
  });

  // Sanity: the backend connection (postgres/BYPASSRLS — superuser in CI) can still read
  // every table. Proves the lock denies CLIENTS without breaking the app's own reads.
  it("the backend connection can still read every locked table", async () => {
    for (const table of LOCKED_TABLES) {
      await expect(client.sql.unsafe(`SELECT 1 FROM "${table}" LIMIT 1`)).resolves.toBeDefined();
    }
  });

  // The guarantee: each client role holds NO DML privilege on each table (proves REVOKE ALL).
  // One `it` per (role, table) so a single missing/partial lock is pinpointed.
  for (const role of CLIENT_ROLES) {
    for (const table of LOCKED_TABLES) {
      it(`${role} has no SELECT/INSERT/UPDATE/DELETE on ${table} (REVOKE ALL)`, async () => {
        for (const priv of DML) {
          const rows = await client.sql.unsafe(
            `SELECT has_table_privilege('${role}', 'public.${table}', '${priv}') AS has`,
          );
          expect(rows[0]!.has, `${role} must NOT have ${priv} on ${table}`).toBe(false);
        }
      });
    }
  }

  // Runtime cross-check: the revoked grant produces a real 42501 at query time, not just
  // a false has_table_privilege bit. Representative table; SET LOCAL ROLE + SELECT share
  // one connection inside a txn.
  it("a revoked role gets a real 42501 at query time (events, anon)", async () => {
    let code: string | undefined;
    try {
      await client.sql.begin(async (sql) => {
        await sql.unsafe(`SET LOCAL ROLE "anon"`);
        await sql.unsafe(`SELECT 1 FROM "events" LIMIT 1`);
      });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe("42501"); // insufficient_privilege
  });
});
