-- ===========================================================================
-- 0085 — #1110: take EXECUTE away from the Data-API roles on the three
--        SECURITY DEFINER functions nobody declared.
--
-- HAND-WRITTEN, NOT GENERATED. Drizzle-kit models tables and columns; it has no opinion about
-- function privileges, so `db:generate` emits nothing for this. `meta/0085_snapshot.json` is a
-- byte-copy of 0084's with a fresh `id` and `prevId` chained to it — the snapshot is genuinely
-- unchanged because no table, column, index or constraint moves here. Same convention as 0082.
--
-- NO SCHEMA CHANGE AT ALL. No CREATE, no ALTER, no DROP, no data touched. This migration only
-- removes privileges from roles that must not have them, and grants nothing to anyone.
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
-- NOBODY CHOSE THAT. It is `ALTER DEFAULT PRIVILEGES ... ON FUNCTIONS GRANT EXECUTE`, which is
-- live on this database for role `postgres` in schema `public` and arrived with Supabase's own
-- 2026-06-24 baseline snapshot. Every function created in `public` by `postgres` gets it. These
-- three are not three mistakes; they are three instances of one default — see the register.
--
-- SEVERITY TODAY IS LOW, AND FOR REASONS THAT ARE ACCIDENTS RATHER THAN CONTROLS. `_log_delete`
-- is a trigger function and Postgres refuses a direct call. `rls_auto_enable` calls
-- `pg_event_trigger_ddl_commands()` and errors outside an event trigger. `is_active_payer_member`
-- answers a question about the CALLER's own `auth.uid()`, and this codebase does not use Supabase
-- Auth, so that is NULL. Two of those three are protected by what the function happens to do,
-- not by a privilege. The posture everywhere else in this schema is REVOKE first and grant
-- deliberately, and functions are the one surface where that had not been applied.
--
-- ===========================================================================
-- WHY THIS CANNOT BREAK THE TRIGGERS — MEASURED, NOT ASSUMED
-- ===========================================================================
-- `_log_delete` fires from two AFTER DELETE triggers on `workers` and `worker_profiles`;
-- `rls_auto_enable` fires from the `ensure_rls` event trigger. The role that runs the statement
-- is the role that matters, and after this migration exactly one role still holds EXECUTE:
-- `postgres`, which keeps its explicit `postgres=X/postgres` grant. Revoking from PUBLIC does
-- not touch an explicit grant to a named role.
--
-- Who actually deletes? All 147 rows in `_delete_forensics` carry `db_user = 'postgres'`, and
-- the backend's own erasure path (`WorkersRepository.hardDelete`) connects as `postgres` too.
-- No other role has ever issued one of these deletes. That is a measurement over the whole
-- table, not an expectation.
--
-- ===========================================================================
-- WHY THE GUARDS, AND WHAT THIS DOES ON A FRESH DATABASE
-- ===========================================================================
-- NOTHING. Deliberately. These functions are UNDECLARED: no migration creates them, so a
-- database built only from this repository does not have them, and there is no privilege to
-- take away. `to_regprocedure` returns NULL there and each loop iteration skips with a NOTICE.
--
-- That makes this migration production-only in effect, which is stated rather than hidden: it
-- constrains objects that exist in exactly one place. If one of them is ever declared properly,
-- the declaring migration owns its own REVOKE tail and this one keeps passing.
--
-- The role guard is the same shape. `anon`, `authenticated` and `service_role` are Supabase
-- roles; a plain Postgres container has none of them, and `REVOKE ... FROM anon` would abort the
-- whole migration there with "role does not exist".
--
-- ===========================================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ===========================================================================
--   1. It does not DROP anything. The ownership question — was the deletion trail deliberate,
--      is it permanent, what is its retention — is not engineering's to answer, and #1110 was
--      scoped read-only until it is answered.
--   2. It does not drop `_delete_forensics.query`. That is the only column that can carry raw
--      PII into an audit record, and it is the second recommendation in the register, held
--      behind the same answer.
--   3. It does not touch ALTER DEFAULT PRIVILEGES. That default is the GENERATOR of this
--      finding, and changing it changes what every future CREATE FUNCTION and CREATE TABLE in
--      `public` means. It is the third recommendation, and it needs a decision, not a patch.
--
-- Verify before and after with:
--   pnpm --filter @badabhai/db db:audit:undeclared-routines --strict
-- ===========================================================================

DO $$
DECLARE
  target   text;
  role_name text;
  targets  text[] := ARRAY[
    'public._log_delete()',
    'public.rls_auto_enable()',
    'public.is_active_payer_member(uuid)'
  ];
  roles    text[] := ARRAY['anon', 'authenticated', 'service_role'];
BEGIN
  FOREACH target IN ARRAY targets LOOP
    IF to_regprocedure(target) IS NULL THEN
      RAISE NOTICE '0085: % is not present on this database — nothing to revoke', target;
      CONTINUE;
    END IF;

    -- PUBLIC first: it is the broadest grant and the one the default privileges create.
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', target);

    FOREACH role_name IN ARRAY roles LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %I', target, role_name);
      END IF;
    END LOOP;

    RAISE NOTICE '0085: revoked EXECUTE on % from PUBLIC, anon, authenticated, service_role', target;
  END LOOP;
END $$;
