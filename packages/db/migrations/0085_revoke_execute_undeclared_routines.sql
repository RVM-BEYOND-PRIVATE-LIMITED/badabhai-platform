-- ===========================================================================
-- 0085 — #1110: stop `EXECUTE` arriving by default, and take it back where it already did.
--
-- HAND-WRITTEN, NOT GENERATED. Drizzle-kit models tables and columns; it has no opinion about
-- function privileges or default ACLs, so `db:generate` emits nothing for this.
-- `meta/0085_snapshot.json` is a byte-copy of 0084's with a fresh `id` and `prevId` chained to
-- it — the snapshot is genuinely unchanged because no table, column, index or constraint moves
-- here. Same convention as 0082.
--
-- NO SCHEMA CHANGE AND NO DATA CHANGE. No CREATE, no ALTER TABLE, no DROP, nothing written to
-- any row. This migration only removes privileges, and grants nothing to anyone.
--
-- THE DELETION-FORENSICS WORK IS `0086`, NOT THIS FILE, and the split is deliberate: privileges
-- and table structure have completely different rollback stories. Everything here is reversed by
-- one `GRANT`; 0086 drops columns, which is not. A single migration doing both would have to be
-- rolled back as a unit, and the expensive half would drag the cheap half with it.
--
-- ===========================================================================
-- WHAT IS BEING REVOKED, AND WHY IT WAS THERE
-- ===========================================================================
-- Production runs three functions in `public` that no migration creates and no schema file
-- describes. All three are `SECURITY DEFINER` — they run as their owner, `postgres`, which is
-- the backend's own BYPASSRLS connection role. All three also hold `EXECUTE` for `PUBLIC`,
-- `anon`, `authenticated` and `service_role`:
--
--   _log_delete             =X/postgres | anon=X | authenticated=X | service_role=X
--   is_active_payer_member  =X/postgres | anon=X | authenticated=X | service_role=X
--   rls_auto_enable         =X/postgres | anon=X | authenticated=X | service_role=X
--
-- NOBODY CHOSE THAT. `pg_default_acl` carries
--
--   grantor=postgres  schema=public  objtype=FUNCTION
--   {postgres=X, anon=X, authenticated=X, service_role=X}
--
-- and it arrived with Supabase's own 2026-06-24 `remote_schema` baseline. Every function created
-- in `public` by `postgres` gets that grant, forever, unless a REVOKE follows it. These three are
-- not three mistakes; they are three instances of one default.
--
-- SECTION A IS THEREFORE THE ONE THAT MATTERS. Section B fixes the three functions that exist;
-- without Section A the fourth function created in this schema arrives with exactly the same
-- grant and nobody is told.
--
-- ===========================================================================
-- "THE MINIMUM APPLICATION-REQUIRED EXECUTION PRIVILEGE" — WHICH IS `postgres`, AND ONLY IT
-- ===========================================================================
-- Owner instruction: *"retain only the minimum application-required execution privilege."*
-- Measured, not assumed:
--
--   * the backend connects as `postgres` (the Supabase session-pooler `postgres.<ref>` user),
--     which OWNS all three functions and holds an explicit `postgres=X/postgres` grant. Revoking
--     from `PUBLIC` never touches an explicit grant to a named role, so the owner keeps EXECUTE.
--   * `service_role` is a Data-API (PostgREST) role, and the Data API cannot reach this schema's
--     data at all: all 78 public tables are RLS-enabled, FORCED, and grant it nothing. It
--     therefore requires no function privilege either.
--   * `anon` and `authenticated` are named explicitly by the owner instruction.
--
-- ⚠ FOR REVIEW: the instruction named `anon` and `authenticated`; this file also revokes
-- `service_role` and `PUBLIC`, because "retain only the minimum" governs and nothing needs
-- either. If `service_role` is meant to keep EXECUTE for a future Data-API surface, delete it
-- from the `roles` array below — that is a one-word change, and it is called out here rather
-- than made silently.
--
-- ===========================================================================
-- WHY THIS CANNOT BREAK THE TRIGGERS — MEASURED, NOT ASSUMED
-- ===========================================================================
-- `_log_delete` fires from two AFTER DELETE triggers on `workers` and `worker_profiles`;
-- `rls_auto_enable` fires from the `ensure_rls` event trigger. The role that runs the statement
-- is the role that matters, and after this migration exactly one role still holds EXECUTE:
-- `postgres`.
--
-- Who actually deletes? All 147 rows in `_delete_forensics` carry `db_user = 'postgres'`, and
-- the backend's own erasure path (`WorkersRepository.hardDelete`) connects as `postgres` too.
-- No other role has ever issued one of these deletes. That is a measurement over the whole
-- table, not an expectation.
--
-- ===========================================================================
-- WHAT SECTION A DOES AND DOES NOT REACH
-- ===========================================================================
-- `ALTER DEFAULT PRIVILEGES` applies to objects created AFTER it runs, by the role it names, in
-- the schema it names. It does not retroactively touch the three functions — that is Section B's
-- job — and it does not touch TABLES or SEQUENCES, whose own default ACLs are left exactly as
-- they are.
--
-- ⚠ THE TABLE DEFAULT IS THE SAME SHAPE AND IS DELIBERATELY NOT TOUCHED HERE. `pg_default_acl`
-- also grants `arwdDxtm` on every new table in `public` to all three Data-API roles, and that is
-- where GAP-DB-21's grants came from. Changing it alters what every future `CREATE TABLE` in a
-- migration means, which is a larger decision with a larger blast radius, and it is recorded as
-- recommendation 4 in the register rather than smuggled in beside a function change.
--
-- ===========================================================================
-- WHAT THIS DOES ON A FRESH DATABASE
-- ===========================================================================
-- Section A: applies. It is a statement about this schema's future, and a fresh database has
-- the same future — this is the one part of the file that is NOT production-only, and that is
-- correct: a container built from these migrations should also not hand EXECUTE to `PUBLIC`.
--
-- Section B: NOTHING. The three functions are undeclared, so a database built only from this
-- repository does not have them, `to_regprocedure` returns NULL and each iteration skips with a
-- NOTICE. The role guard is the same shape: `anon`, `authenticated` and `service_role` are
-- Supabase roles, and `REVOKE ... FROM anon` on a plain container would abort the migration with
-- "role does not exist".
--
-- ROLLBACK. One statement per line reversed:
--   Section A:  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--                 GRANT EXECUTE ON FUNCTIONS TO PUBLIC;            (and per role)
--   Section B:  GRANT EXECUTE ON FUNCTION public.<fn> TO <role>;
-- Nothing here destroys anything, so rollback is total.
--
-- Verify before and after with:
--   pnpm --filter @badabhai/db db:audit:undeclared-routines --strict
--   npx tsx packages/db/adopt-migrations.ts --only 0085_revoke_execute_undeclared_routines
-- ===========================================================================

-- ── SECTION A ── the default that creates the finding ────────────────────────────────────────
DO $$
DECLARE
  role_name text;
  roles     text[] := ARRAY['anon', 'authenticated', 'service_role'];
BEGIN
  -- PUBLIC first: it is the broadest, it always exists, and it is what Postgres itself grants.
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public '
       || 'REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';

  FOREACH role_name IN ARRAY roles LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public '
        || 'REVOKE EXECUTE ON FUNCTIONS FROM %I', role_name);
    ELSE
      RAISE NOTICE '0085: role % does not exist here — nothing to revoke from', role_name;
    END IF;
  END LOOP;

  RAISE NOTICE '0085: new functions in public no longer arrive with EXECUTE for the Data-API roles';
END $$;

-- ── SECTION B ── the three that already have it ──────────────────────────────────────────────
DO $$
DECLARE
  target    text;
  role_name text;
  targets   text[] := ARRAY[
    'public._log_delete()',
    'public.rls_auto_enable()',
    'public.is_active_payer_member(uuid)'
  ];
  roles     text[] := ARRAY['anon', 'authenticated', 'service_role'];
BEGIN
  FOREACH target IN ARRAY targets LOOP
    IF to_regprocedure(target) IS NULL THEN
      RAISE NOTICE '0085: % is not present on this database — nothing to revoke', target;
      CONTINUE;
    END IF;

    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', target);

    FOREACH role_name IN ARRAY roles LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %I', target, role_name);
      END IF;
    END LOOP;

    RAISE NOTICE '0085: revoked EXECUTE on % from PUBLIC, anon, authenticated, service_role', target;
  END LOOP;
END $$;
