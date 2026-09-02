-- ===========================================================================
-- 0099 — matching_catalog: RVM-ratified domain truth as PUBLISHED CONFIG
--
-- !! THE JOURNAL `when` FOR THIS ENTRY IS PINNED. DO NOT REGENERATE BLINDLY. !!
--
-- `meta/_journal.json` carries when=1788337451822 for 0099. Running `drizzle-kit
-- generate` again stamps a NEW `when`, and because drizzle skips any entry whose
-- `when` is below MAX(created_at) in `__drizzle_migrations`, a re-stamped 0099 gets
-- RE-RUN against a database that already has this table: it dies on "relation already
-- exists" and blocks every later migration behind it. Silently, on the deploy. If you
-- regenerate, pin `when` back to 1788337451822 and diff the executable DDL (comments
-- and whitespace stripped) against what is here — the only legitimate change is
-- formatting. There is no schema<->migration drift gate in CI to catch it for you
-- (supabase-checks.yml is disabled_manually, TD97).
--
-- THIS FILE WAS FIRST GENERATED AS 0095 AND WAS WRONG. The branch it was authored on
-- was 48 commits behind origin/main, where 0095/0096/0097/0098 already existed, so the
-- number collided AND the snapshot was diffed against a schema four migrations stale.
-- It was regenerated from scratch on a fresh worktree cut from origin/main rather than
-- renamed: renaming the .sql leaves `meta/<n>_snapshot.json` and the journal entry
-- still pointing at the wrong base, which is the same failure wearing a correct
-- filename.
--
-- ONE NEW, EMPTY TABLE. Nothing existing is touched: no column is added, dropped,
-- renamed or re-typed on any shipped table, no constraint is relaxed, no index is
-- rebuilt, no policy is changed. Rollback is one table drop and the database is
-- byte-identical to 0098.
--
-- ===========================================================================
-- WHAT THIS TABLE IS FOR
-- ===========================================================================
-- The role registry, domains, families, directed adjacency multipliers, the function
-- and collar-tier multiplier matrices, and the per-role attribute whitelists — all as
-- one published, versioned jsonb blob.
--
-- Master-context §32 keeps every one of those OUTSIDE the schema deliberately: they
-- change on RVM's clock, not on a deploy's. After this table exists, taxonomy churn is
-- a data publish with RVM sign-off rather than a code change. Spec §D step 2 calls it
-- "the highest-leverage single change" in the matching plan.
--
-- THE TABLE SHIPS EMPTY. Rulings R1-R4 are open (how the Aug-9 ladders decompose into
-- (function, collar_tier), how the families re-cut, whether Design & Drafting is the
-- 11th domain, and how the three role overlaps resolve). This migration ships
-- STRUCTURE; the values arrive when RVM signs. The only row any seeder inserts is the
-- synthetic FIXTURE, with is_active = false — see @badabhai/matching-catalog.
--
-- ===========================================================================
-- WHY A SEPARATE TABLE FROM `match_config`, WHICH HAS THE IDENTICAL SHAPE
-- (owner ruling 2026-09-02 — recorded so this reads as a rejection, not an oversight)
-- ===========================================================================
--   * Different sign-off authority. `match_config` is engineering knobs; this is RVM
--     domain truth. Publishing a taxonomy version must not require republishing engine
--     knobs, or the reverse.
--   * Different cadence. Knobs move during tuning; taxonomy moves when RVM signs.
--   * Decisive: bundled, every `boost_supply_floor` tweak would write a new row
--     carrying the entire taxonomy blob, and the audit trail stops telling you what
--     actually changed. Config rows that move on different clocks do not share a row.
--
-- COLUMN NAMES mirror `pricing_catalog` and `match_config` exactly — `catalog` /
-- `revision` / `updated_by`. Both were re-read at origin/main 6f377032 and are
-- unchanged. An earlier spec parenthetical called for `catalog_json` / `version` /
-- `published_by`; it described no table that exists and has been corrected at source.
--
-- ===========================================================================
-- THE CONSTRAINTS THAT CARRY THE P1 INVARIANT
--   "an invalid catalog can never become the active one"
-- ===========================================================================
--   matching_catalog_active_uq   AT MOST ONE active row. Deliberately not "exactly
--                                one": the fixture ships inactive and a fresh database
--                                legitimately has ZERO active catalogs. That is the
--                                state getActive() reports as null — it must NEVER be
--                                papered over with a fixture fallback, because a tier
--                                resolver running on placeholder ids produces matches
--                                against opaque roles and nobody finds out for weeks.
--
--   mc_active_shape_chk          STRUCTURAL TEETH. An ACTIVE row must carry the seven
--                                top-level containers with the right jsonb types. This
--                                is what stops a hand-written
--                                `UPDATE matching_catalog SET is_active = true`
--                                — one that never goes near the API or the validator —
--                                from activating a garbage blob.
--
--                                IT IS DELIBERATELY SHALLOW. Semantic validity (an
--                                adjacency edge pointing at an unknown role, a
--                                multiplier outside [0.00, 1.00], a role with a
--                                dangling family, a function value outside the locked
--                                nine) is NOT expressible in a CHECK without a
--                                PL/pgSQL trigger, and a CHECK that calls a validator
--                                function is a maintenance trap. Those are enforced by
--                                validateMatchingCatalog() at publish time, inside the
--                                publishing transaction.
--
--                                !! BUMPING MATCHING_CATALOG_SCHEMA_VERSION IN A WAY
--                                THAT CHANGES THESE TOP-LEVEL CONTAINERS REQUIRES A
--                                FOLLOW-UP MIGRATION TO THIS CONSTRAINT. A v2 blob
--                                that renames or drops one of the seven keys will be
--                                refused activation by Postgres with a constraint
--                                violation, not by the validator — do not discover
--                                that by being blocked on a deploy. !!
--
--   matching_catalog_revision_uq A revision number is never reusable, active or not.
--                                It is the citation in an RVM sign-off packet, so
--                                "catalog revision 7" must mean exactly one blob
--                                forever.
--
-- PII-FREE by shape: machine ids, display labels and numbers only. Invariant #4 —
-- these are DETERMINISTIC matching parameters; an LLM neither writes nor reads them,
-- and it may never produce a canonical id.
-- ===========================================================================
CREATE TABLE "matching_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"catalog" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matching_catalog_revision_positive_chk" CHECK ("matching_catalog"."revision" >= 1),
	CONSTRAINT "mc_active_shape_chk" CHECK ("matching_catalog"."is_active" = false OR (
        jsonb_typeof("matching_catalog"."catalog" -> 'schemaVersion') = 'number'
        AND jsonb_typeof("matching_catalog"."catalog" -> 'domains') = 'array'
        AND jsonb_typeof("matching_catalog"."catalog" -> 'families') = 'array'
        AND jsonb_typeof("matching_catalog"."catalog" -> 'roles') = 'array'
        AND jsonb_typeof("matching_catalog"."catalog" -> 'adjacency') = 'array'
        AND jsonb_typeof("matching_catalog"."catalog" -> 'functionMultiplier') = 'object'
        AND jsonb_typeof("matching_catalog"."catalog" -> 'collarTierBand') = 'object'
      ))
);
--> statement-breakpoint
ALTER TABLE "matching_catalog" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "matching_catalog_active_uq" ON "matching_catalog" USING btree ("is_active") WHERE "matching_catalog"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "matching_catalog_revision_uq" ON "matching_catalog" USING btree ("revision");--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT — RLS forced, every role revoked, and NO POLICY.
--
-- The same posture `pricing_catalog` and `match_config` carry, and for the same
-- reason: nothing reaches these rows except the API's BYPASSRLS connection. FORCE
-- matters because it applies to the table OWNER too, so a future `postgres`-owned job
-- cannot rewrite the taxonomy by accident. A policy is not merely absent here — with
-- FORCE and no policy the table is closed, and any later policy is an explicit,
-- reviewable decision.
--
-- This table holds no PII, but it decides which workers see which jobs. A write here
-- is a silent, platform-wide change to matching, which makes it exactly as
-- write-sensitive as pricing (see R31: the pricing catalog shipped UNAUTHENTICATED,
-- and the read side leaked the whole catalog). The API routes ride
-- InternalServiceGuard for the same reason.
-- ===========================================================================
ALTER TABLE "matching_catalog" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "matching_catalog" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "matching_catalog" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "matching_catalog" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "matching_catalog" FROM service_role;
