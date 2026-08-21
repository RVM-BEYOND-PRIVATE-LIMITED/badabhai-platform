-- ===========================================================================
-- 0087 — #1110 recommendation 4: stop every NEW table in `public` arriving pre-granted
--        to the Data-API roles.
--
-- OWNER DECISION, 2026-08-21: *"same treatment as 0085 Section A"* — applied to TABLES.
--
-- HAND-WRITTEN, NOT GENERATED. Drizzle-kit models tables and columns; it has no opinion about
-- default ACLs, so `db:generate` emits nothing for this. `meta/0087_snapshot.json` is a byte-copy
-- of 0086's with a fresh `id` and `prevId` chained to it — genuinely unchanged, because no table,
-- column, index or constraint moves here. Same convention as 0082 and 0085.
--
-- NO SCHEMA CHANGE AND NO DATA CHANGE. No CREATE, no ALTER TABLE, no DROP, nothing written to
-- any row. This migration only removes privileges, and grants nothing to anyone.
--
-- ===========================================================================
-- THIS IS THE ROOT CAUSE OF GAP-DB-21, NOT A TIDY-UP
-- ===========================================================================
-- `pg_default_acl` carries, for this schema:
--
--   grantor=postgres  schema=public  objtype=TABLE
--   {postgres=arwdDxtm, anon=arwdDxtm, authenticated=arwdDxtm, service_role=arwdDxtm}
--
-- so every table created in `public` by `postgres` arrives with FULL DML for all three Data-API
-- roles, forever, unless a REVOKE follows it. `agency_profiles`, `employer_profiles`,
-- `payer_capabilities` and `payer_member_invites` were not four mistakes — they were four
-- instances of that one default, which is why they read as RLS-enabled and were simultaneously
-- FORCE-less and fully granted.
--
-- It arrived with Supabase's own 2026-06-24 `remote_schema` baseline. Nobody chose it.
--
-- 0085 fixed the identical default for FUNCTIONS and the owner approved that shape. This is the
-- same statement about the same schema's future, for the object type that actually holds the
-- rows.
--
-- ===========================================================================
-- WHY THIS CANNOT BREAK ANYTHING TODAY — MEASURED, NOT ASSUMED
-- ===========================================================================
--   * `ALTER DEFAULT PRIVILEGES` applies ONLY to objects created AFTER it runs. It does not
--     retroactively touch a single existing table. All 78 public tables keep exactly the ACL
--     they have now; nothing this platform serves changes.
--   * The Data API cannot reach this schema's data regardless: `db:audit:rls` reads 78/78
--     RLS-enabled, FORCED and granting the Data-API roles nothing. The grant was already dead
--     weight — this stops it being re-issued.
--   * The backend connects as `postgres`, which OWNS the tables. Ownership is not a grant and is
--     untouched by any REVOKE below, so the application keeps full access to every future table.
--   * `service_role` has `rolbypassrls = true`, so for THAT role the grant was never redundant —
--     it was the whole control. Removing it is the point.
--
-- ===========================================================================
-- SCOPE — TABLES ONLY. SEQUENCES ARE DELIBERATELY LEFT ALONE.
-- ===========================================================================
-- `pg_default_acl` carries a comparable default for SEQUENCES. It is NOT touched here, for the
-- same reason 0085 did not touch tables: one object type per decision, so each has its own
-- rollback story and its own review. A sequence discloses a row count at most; the table default
-- is the one that GAP-DB-21 was made of. Recorded rather than bundled.
--
-- ===========================================================================
-- WHAT THIS DOES ON A FRESH DATABASE
-- ===========================================================================
-- It APPLIES, and that is the point rather than a side effect: a container built from these
-- migrations should also not hand full DML on new tables to roles that must never have it. The
-- three Supabase roles do not exist on a plain Postgres container, so each is guarded — a bare
-- `REVOKE ... FROM anon` there would abort the migration with "role does not exist". `PUBLIC`
-- always exists and is revoked unconditionally.
--
-- ROLLBACK. Total, one statement per line reversed:
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     GRANT ALL ON TABLES TO PUBLIC;                    (and per role)
-- Nothing here destroys anything.
--
-- Verify before and after with:
--   pnpm --filter @badabhai/db db:audit:rls
--   npx tsx packages/db/adopt-migrations.ts --only 0087_default_privileges_tables
-- ===========================================================================

DO $$
DECLARE
  role_name text;
  roles     text[] := ARRAY['anon', 'authenticated', 'service_role'];
BEGIN
  -- PUBLIC first: it is the broadest, it always exists, and it is what Postgres itself grants.
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public '
       || 'REVOKE ALL ON TABLES FROM PUBLIC';

  FOREACH role_name IN ARRAY roles LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public '
        || 'REVOKE ALL ON TABLES FROM %I', role_name);
    ELSE
      RAISE NOTICE '0087: role % does not exist here — nothing to revoke from', role_name;
    END IF;
  END LOOP;

  RAISE NOTICE '0087: new tables in public no longer arrive with DML for the Data-API roles';
END $$;
