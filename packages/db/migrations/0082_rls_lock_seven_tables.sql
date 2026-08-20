-- ===========================================================================
-- 0082 — CLOSE R39: the seven public tables that are not RLS-locked
--
-- HAND-WRITTEN, NOT GENERATED. Drizzle-kit models `ENABLE ROW LEVEL SECURITY` and nothing
-- else about the lock — not FORCE, not the grants — so there is no model change to generate
-- from and `db:generate` emits nothing for this. `meta/0082_snapshot.json` is therefore a
-- byte-copy of 0081's with a fresh `id` and `prevId` chained to it: the snapshot is genuinely
-- unchanged because no table, column, index or constraint moves here.
--
-- NO SCHEMA CHANGE AT ALL. No CREATE, no ALTER COLUMN, no DROP. This migration only changes
-- who may reach seven tables. It is additive in the only sense that matters — it removes
-- privileges from roles that must not have them and grants nothing to anyone.
--
-- ===========================================================================
-- WHAT R39 ACTUALLY IS
-- ===========================================================================
-- `pnpm --filter @badabhai/db db:audit:rls` sweeps every public table for the three conditions
-- the house pattern requires: RLS enabled, FORCE, and no grant to a Data-API role. Seven of 77
-- fail. Measured against production on 2026-08-20, every one of the seven is EMPTY (0 rows),
-- owned by `postgres`, and carries 0 policies:
--
--   agency_kyc               enabled  FORCED      anon+authenticated+service_role granted
--   agency_payout_accruals   enabled  FORCED      anon+authenticated+service_role granted
--   agency_payout_requests   enabled  FORCED      anon+authenticated+service_role granted
--   agency_profiles          enabled  NOT forced  anon+authenticated+service_role granted
--   employer_profiles        enabled  NOT forced  anon+authenticated+service_role granted
--   payer_capabilities       enabled  NOT forced  anon+authenticated+service_role granted
--   payer_member_invites     enabled  NOT forced  anon+authenticated+service_role granted
--
-- THE GRANT IS THE FINDING, NOT THE MISSING FORCE. "RLS is on with zero policies, so everything
-- is denied" is true for `anon` and `authenticated` (rolbypassrls = false) and FALSE for
-- `service_role`, which has rolbypassrls = TRUE. RLS does not apply to it at all; the only
-- control on that role is the grant, and on these seven the grant is wide open — every DML
-- privilege plus TRUNCATE. That is why the house pattern REVOKEs rather than trusting RLS, and
-- why three tables can be correctly FORCEd and still be reachable.
--
-- LATENT, NOT ACTIVE. All seven hold zero rows, so nothing is exposed today. What is exposed is
-- the FIRST row anyone writes — `agency_kyc` is PAN and bank ciphertext plus a keyed HMAC, the
-- highest-sensitivity financial PII on the platform (ADR-0022 Amdt 2, ADR-0004 discipline). The
-- cost of fixing it while empty is zero and the cost of discovering it after the agency KYC flow
-- goes live is not.
--
-- ===========================================================================
-- WHY TWO SECTIONS
-- ===========================================================================
-- The seven divide cleanly and the two halves need different SQL.
--
-- SECTION A — three tables migration 0048 already declares. 0048 contains FORCE and all four
-- REVOKEs for each of them (lines 70-95). Its DDL is live and it is RECORDED in the journal, but
-- its REVOKE tail never ran on production: the table bodies were applied out-of-band, Supabase's
-- default privileges granted the Data-API roles at CREATE time, and the tail that would have
-- taken them back was skipped. `adopt-migrations.ts` then recorded 0048 as applied — it verifies
-- tables, columns, indexes, constraints and RLS enable/force, and does NOT look at grants, so
-- the gap was invisible to the one tool that could have caught it (GAP-DB-19/GAP-DB-20).
-- Re-stating the lock here is the fix; it is a no-op wherever 0048 ran in full, which is every
-- environment except production.
--
-- SECTION B — four tables that exist in NO migration and NO Drizzle schema file (GAP-DB-21).
-- They are dead scaffolding from an abandoned design: `payer_member_invites` FKs to `auth.users`
-- (Supabase Auth, which this codebase does not use) and `payer_capabilities` is a per-payer
-- boolean permission matrix superseded by the shipped `org_role` enum. All four are empty and
-- unreferenced by any code path in this repository.
--
-- Because they exist only on production, Section B is GUARDED by `to_regclass`. An unconditional
-- `ALTER TABLE "agency_profiles" …` would abort this migration on every fresh database — CI,
-- the e2e job, a new developer's docker Postgres — and take the whole 0082 slot down with it.
-- The guard makes the statement a no-op exactly where the table is absent and says so in a
-- NOTICE, so a fresh-environment apply is quiet rather than silent.
--
-- DROP IS THE BETTER END STATE, AND IS NOT THIS MIGRATION. GAP-DB-21's recorded recommendation
-- is to drop all four. That is a destructive production action on tables no one has ruled on, so
-- it needs an owner's decision and a migration of its own. Locking them costs nothing, is
-- reversible, and does not prejudge that ruling — a dropped table is trivially locked.
--
-- ===========================================================================
-- SAFETY
-- ===========================================================================
-- FORCE CANNOT LOCK THE APPLICATION OUT. FORCE makes RLS apply to the table owner, and with zero
-- policies anywhere in this schema that would be a total denial — except that `rolbypassrls`
-- outranks it. Measured on production 2026-08-20: `postgres` (the owner, and the only role the
-- backend connects as) has rolbypassrls = true; `anon` and `authenticated` have it false;
-- `service_role` has it true, which is the whole reason the REVOKE is load-bearing. The same
-- reasoning already carries `worker_feedback`, FORCEd in 0080 and serving live traffic since.
--
-- THE REVOKES WILL ACTUALLY TAKE. A REVOKE only removes privileges the executing role can
-- revoke. Every existing grant on all seven tables has `grantor = postgres` (measured), and this
-- migration runs as `postgres`, so none of them is a silent no-op. `pnpm db:verify:rls-lock`
-- proves this against the live database inside a transaction that cannot commit — run it before
-- applying, and again after.
--
-- IDEMPOTENT. FORCE on an already-forced table and REVOKE of an absent grant are both no-ops in
-- Postgres, not errors. Re-running this migration changes nothing.
--
-- TIMING. Each statement takes ACCESS EXCLUSIVE on its table for the microseconds it runs — no
-- table rewrite, no scan, seven empty tables. It queues behind any in-flight transaction on the
-- three agency tables, so per the 0073/0077/0080 precedent: run under `SET lock_timeout = '3s';`
-- and retry on 55P03.
--
-- ROLLBACK. Restore the previous posture by re-granting; nothing is lost and no data moves.
--   ALTER TABLE "agency_profiles" NO FORCE ROW LEVEL SECURITY;   -- and the other three of B
--   GRANT ALL ON TABLE "agency_kyc" TO anon, authenticated, service_role;   -- and the rest
-- There is no reason to: the grants being restored are the finding.
--
-- COVERAGE. `db:audit:rls` sweeps all 77 live tables and is the authority for Section B, which
-- cannot be in the deploy-readiness manifest because those tables exist in one environment only.
-- `schema-contract.ts` carries the three Section-A tables as `kind: "rls"` requirements, so
-- `db:audit:schema-contract` reports production NOT READY until this migration is applied.
-- `tests/e2e/rls-spine.e2e.test.ts` already lists the three; the four are deliberately absent
-- from its LOCKED_TABLES, because that suite asserts set-equality against a freshly migrated
-- database where they do not exist.
--
-- MIGRATION SLOT. Minted as `0081`, RENUMBERED to `0082` before merge — the fourth collision
-- this repository has recorded. `#1036` took `0081` (`0081_worker_feedback_screen_context`) and
-- APPLIED IT TO PRODUCTION while this branch was in flight, so the clash was not only in the
-- tree, it was already in `drizzle.__drizzle_migrations`. Nothing local reported it: every tool
-- asked "is each FILE recorded?" and none asked "is each RECORDED ROW a file?". That direction
-- is now part of `adopt-migrations.ts --doctor`.
--
-- REGENERATED, NOT RENAMED (the 0071 rule): the snapshot was re-derived from `0081`'s, so
-- `0082_snapshot.json.prevId == 0081_snapshot.json.id` and the chain is unbroken. Verified —
-- `npx drizzle-kit generate` emits "No schema changes, nothing to migrate". The pre-renumber
-- file was never applied to any database, so its `when` needed no pinning. **OIE moves to
-- `0083`.**
-- ===========================================================================

-- ── SECTION A — the three tables 0048 declares. Unconditional: they exist everywhere. ──
ALTER TABLE "agency_kyc" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_kyc" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_kyc" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_kyc" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_kyc" FROM service_role;--> statement-breakpoint

ALTER TABLE "agency_payout_accruals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_payout_accruals" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_payout_accruals" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_payout_accruals" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_payout_accruals" FROM service_role;--> statement-breakpoint

ALTER TABLE "agency_payout_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_payout_requests" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_payout_requests" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_payout_requests" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "agency_payout_requests" FROM service_role;--> statement-breakpoint

-- ── SECTION B — the four unmodelled tables (GAP-DB-21). Guarded: production-only. ──
-- One loop rather than four blocks, so the name list cannot drift out of sync with the SQL.
-- `format(… %I)` quotes each identifier, so nothing here is string-concatenated into DDL.
DO $$
DECLARE
  t text;
  unmodelled CONSTANT text[] := ARRAY[
    'agency_profiles',
    'employer_profiles',
    'payer_capabilities',
    'payer_member_invites'
  ];
BEGIN
  FOREACH t IN ARRAY unmodelled LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE NOTICE '0082: % absent — nothing to lock (expected on any database but production)', t;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM service_role', t);
    RAISE NOTICE '0082: % locked (ENABLE + FORCE + 4 REVOKEs)', t;
  END LOOP;
END $$;
