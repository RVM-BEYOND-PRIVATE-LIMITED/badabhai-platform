-- ===========================================================================
-- 0088 — #1110: declare and HARDEN `ensure_rls`, and drop the policy helper nothing uses.
--
-- OWNER DECISIONS, 2026-08-21:
--   * `ensure_rls`            -> *"Keep it, declare it, and harden it"* — full house posture
--                                (ENABLE + FORCE + REVOKE) and no swallowed errors.
--   * `is_active_payer_member` -> *"Drop it"*.
--
-- HAND-WRITTEN, NOT GENERATED. Drizzle-kit models tables and columns; it has no opinion about
-- functions or event triggers. `meta/0088_snapshot.json` is a byte-copy of 0087's with a fresh
-- `id` and `prevId` chained to it — genuinely unchanged, because no table, column, index or
-- constraint moves here. Same convention as 0082, 0085 and 0087.
--
-- ===========================================================================
-- WHY `ensure_rls` IS BEING CHANGED RATHER THAN JUST WRITTEN DOWN
-- ===========================================================================
-- Production runs an event trigger on `ddl_command_end` that fires `rls_auto_enable()` on every
-- `CREATE TABLE` in `public`. It exists in no migration and no document, it was created with this
-- project's own `postgres` credentials out of band, and it **enables RLS and does nothing else**:
-- no `FORCE`, no `REVOKE`.
--
-- That single fact explains GAP-DB-21 completely. `agency_profiles`, `employer_profiles`,
-- `payer_capabilities` and `payer_member_invites` were RLS-**enabled** and simultaneously
-- FORCE-less and granted to every Data-API role — which read as half a lock applied by hand and
-- was instead a whole mechanism working exactly as written. Since `service_role` has
-- `rolbypassrls = true`, "RLS is on" was never the control on that role; the grant was. The
-- trigger produced tables that LOOKED protected and were not.
--
-- So declaring it as-is would ship a known false assurance into every environment. The house
-- posture is three conditions and this implemented one; the owner ruled it up to three.
--
-- ===========================================================================
-- THE EXCEPTION HANDLER IS REMOVED, AND THAT IS A BEHAVIOUR CHANGE — READ THIS
-- ===========================================================================
-- The live function ends with:
--
--     EXCEPTION WHEN OTHERS THEN
--       RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
--
-- A failure was invisible outside the server log, and a table created during a failure window
-- was simply unprotected with nothing anywhere saying so. Swallowing `WHEN OTHERS` on a security
-- control is what turns a backstop into a false assurance.
--
-- Without it, a failure to lock a table ABORTS the `CREATE TABLE` that triggered it. That is
-- deliberate and it is the fail-closed rule: a table that cannot be locked must not come into
-- existence. It is also the reason every role reference below is guarded — the failure mode this
-- must never have is "a legitimate CREATE TABLE now fails because `anon` does not exist here".
--
-- ===========================================================================
-- WHY THIS DOES NOT RECURSE
-- ===========================================================================
-- The function issues `ALTER TABLE` and `REVOKE`, which are themselves DDL and raise their own
-- `ddl_command_end`. The `WHEN TAG IN (...)` filter on the event trigger is what stops that
-- becoming infinite: `ALTER TABLE` and `REVOKE` are not in the list, so they cannot re-enter.
-- The filter is a hardening in its own right — a tag-less event trigger would fire on every DDL
-- statement in every migration.
--
-- ===========================================================================
-- PRIVILEGE: THIS NEEDS SUPERUSER, AND THE CHAIN ALREADY DID
-- ===========================================================================
-- `CREATE EVENT TRIGGER` requires superuser. That is not a new requirement for this repository:
-- migration `0001` runs `CREATE EXTENSION vector`, which also does. Measured on the two places
-- these migrations actually run:
--   * CI E2E — `pgvector/pgvector:pg16` with `POSTGRES_USER: postgres` (superuser).
--   * production — Supabase, where `postgres` already owns the live `ensure_rls`, so it created
--     one before.
-- If a future environment runs migrations as a non-superuser, `0001` fails long before this file.
--
-- ===========================================================================
-- WHAT THIS DOES WHERE
-- ===========================================================================
-- PRODUCTION: `CREATE OR REPLACE` swaps the function body for the hardened one; the event
-- trigger is recreated with the tag filter. Both are idempotent, so re-running is a no-op.
-- **No existing table is touched** — an event trigger only ever sees tables created after it, and
-- all 78 public tables are already ENABLE + FORCE + revoked (`db:audit:rls` reads 78/78 locked).
--
-- A FRESH DATABASE: gets the trigger for the first time, which is the entire point of declaring
-- it — the two environments stop diverging on the first `CREATE TABLE`. Tables created by
-- migrations 0001–0087 are unaffected, because this file runs after them and they carry their own
-- explicit ENABLE/FORCE/REVOKE (0082, 0084).
--
-- ⚠ FOR WHOEVER ADDS THE NEXT TABLE: after this, a new table in `public` is locked the moment it
-- is created. If one legitimately needs Data-API access, `GRANT` explicitly AFTER the `CREATE` —
-- the trigger runs at the CREATE's `ddl_command_end`, so a later explicit grant still wins. Do
-- not weaken the trigger to make one table reachable.
--
-- ROLLBACK.
--   the function        : `CREATE OR REPLACE` the previous body (enable-only, WHEN OTHERS).
--   the event trigger   : `DROP EVENT TRIGGER ensure_rls;` restores the pre-0088 production
--                         state minus the trigger; recreate without the tag filter to match it
--                         exactly.
--   is_active_payer_member : recreate from the production-read BODY preserved in Section C.
--                         The CREATE wrapper was never captured, so re-derive it.
--
-- Verify before and after with:
--   pnpm --filter @badabhai/db db:audit:undeclared-routines --strict
--   pnpm --filter @badabhai/db db:audit:rls
--   npx tsx packages/db/adopt-migrations.ts --only 0088_declare_ensure_rls_drop_policy_helper
-- ===========================================================================

-- ── SECTION A ── the hardened function ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rls_auto_enable()
  RETURNS event_trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  -- Pinned so a caller-controlled `search_path` cannot redirect the catalog lookups below. A
  -- SECURITY DEFINER function without this is the classic privilege-escalation shape.
  SET search_path = pg_catalog, public
AS $fn$
DECLARE
  cmd       record;
  role_name text;
  roles     text[] := ARRAY['anon', 'authenticated', 'service_role'];
BEGIN
  FOR cmd IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
    -- Only real tables, only in `public`, and never an extension's own (pgvector creates its
    -- tables here too, and they are the extension's business rather than ours).
    CONTINUE WHEN cmd.object_type IS DISTINCT FROM 'table';
    CONTINUE WHEN cmd.schema_name IS DISTINCT FROM 'public';
    CONTINUE WHEN cmd.in_extension;

    -- `object_identity` is already schema-qualified and correctly quoted by Postgres, so it is
    -- interpolated with %s. Using %I here would double-quote it and the statement would fail.
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', cmd.object_identity);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', cmd.object_identity);
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC', cmd.object_identity);

    FOREACH role_name IN ARRAY roles LOOP
      -- Guarded: these are Supabase roles and do not exist on a plain container. Unguarded, a
      -- perfectly good CREATE TABLE would abort there with "role does not exist" — and with the
      -- exception handler gone, that abort is real rather than logged.
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', cmd.object_identity, role_name);
      END IF;
    END LOOP;

    RAISE NOTICE 'ensure_rls: locked % — enabled, forced, revoked', cmd.object_identity;
  END LOOP;
END
$fn$;

-- The function is SECURITY DEFINER, so it must not be executable by the Data-API roles. 0085
-- Section A stops that grant arriving by default, but `CREATE OR REPLACE` above preserves the
-- ACL the live function already has — which still carries the pre-0085 grants on production.
-- Re-revoking here is what makes this file correct whether or not 0085 ran first.
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC;

DO $$
DECLARE
  role_name text;
  roles     text[] := ARRAY['anon', 'authenticated', 'service_role'];
BEGIN
  FOREACH role_name IN ARRAY roles LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM %I', role_name);
    END IF;
  END LOOP;
END $$;

-- ── SECTION B ── the event trigger, with the tag filter that stops it recursing ───────────────
DROP EVENT TRIGGER IF EXISTS ensure_rls;

CREATE EVENT TRIGGER ensure_rls
  ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION public.rls_auto_enable();

-- ── SECTION C ── the policy helper for a policy that was never written ───────────────────────
--
-- `is_active_payer_member(uuid)` reads `auth.uid()` against `payer_members.user_id` — Supabase
-- Auth, which this codebase does not use. Measured on production 2026-08-20:
--   * policies referencing it        0   (`pg_policies` in `public` is empty)
--   * callers in this repository     0
-- It is a helper for a policy-based design that was never written, and an undeclared
-- SECURITY DEFINER function nobody can account for.
--
-- NOT `CASCADE`, deliberately. If anything ever does depend on it, this migration must fail
-- loudly rather than quietly drop the dependent object too.
--
-- Its body, for rollback. This is the definition READ FROM PRODUCTION on 2026-08-20 and recorded
-- in `docs/registers/gap-db-undeclared-routines.md` §3 — not a reconstruction. Once the drop runs,
-- the register and this file are the only record, which is why it is repeated here rather than
-- cited:
--
--   SELECT EXISTS (
--     SELECT 1 FROM public.payer_members pm
--     WHERE pm.payer_id = target_payer_id
--       AND pm.user_id = auth.uid()
--       AND pm.status = 'active'
--   );
--
-- declared `SECURITY DEFINER`, `STABLE`, owned by `postgres`, taking one `uuid` argument named
-- `target_payer_id`. The wrapper (`CREATE FUNCTION ... RETURNS boolean LANGUAGE sql`) was not
-- captured verbatim, so a rollback should re-derive it rather than paste it — the body is the
-- part that carries the meaning.
DROP FUNCTION IF EXISTS public.is_active_payer_member(uuid);
