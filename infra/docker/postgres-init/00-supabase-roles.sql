-- Create the Supabase client-facing roles in the LOCAL Postgres container.
--
-- WHY THIS FILE EXISTS. 26 of the 64 migrations REVOKE or GRANT on `anon`,
-- `authenticated` and `service_role` — the roles Supabase's PostgREST Data API connects
-- as. ADR-0004 (`0004_workers_force_rls_revoke.sql`) is the first: RLS alone never
-- constrains a BYPASSRLS role, so the real control is removing the grant.
--
-- Supabase ships those roles. A vanilla `pgvector/pgvector:pg16` does not. So on a
-- plain container the chain died on migration 0004 with:
--
--     role "anon" does not exist   (SQLSTATE 42704)
--
-- ...which meant `pnpm db:up && pnpm db:migrate` — the documented local path, and the
-- first two steps of the admin foundation runbook — could NEVER complete from an empty
-- database. Found 2026-08-03 by actually running it (CLAUDE.md invariant #10); it had
-- been invisible because every existing developer database predates 0004 or was created
-- against Supabase.
--
-- WHY HERE AND NOT IN A MIGRATION. Editing 26 shipped migrations to guard each
-- statement would change their hashes, and drizzle keys applied migrations by hash — a
-- database that already ran them (staging, Supabase) would see 26 "new" migrations and
-- re-apply them. This is an ENVIRONMENT gap, so it is fixed in the environment: the
-- local container now looks like the platform the migrations were written against.
--
-- Files in /docker-entrypoint-initdb.d/ run ONCE, only when the data directory is
-- empty — i.e. exactly on the `docker compose down -v` + `up` flow the runbook uses.
--
-- NOT A SECURITY RELAXATION. These roles are NOLOGIN: nothing can connect as them.
-- Creating them is what lets the REVOKEs actually execute, so the local database ends
-- up MORE faithful to production, not less. `service_role` carries BYPASSRLS to match
-- Supabase — which is precisely the role ADR-0004 revokes the `workers` grant from, and
-- the reason that REVOKE is the real control rather than the RLS policy.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;

  -- BYPASSRLS mirrors Supabase. Deliberate: it is what makes the ADR-0004 REVOKE a
  -- meaningful test locally instead of a no-op against a role that could not bypass
  -- anything anyway.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$$;
