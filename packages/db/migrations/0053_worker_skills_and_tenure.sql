-- Matching V1 — step 2 of 7: the SUPPLY side (worker_skill + worker_industry_tenure).
--
-- EXPAND-ONLY. Two NEW tables. No existing table, column, constraint or index is
-- touched, so nothing that ships today can break: until the D2 backfill runs, both
-- tables are simply empty.
--
--   * worker_skill            — one row per (worker, match skill). THE reach driver.
--   * worker_industry_tenure  — calendar months per (worker, industry), the rank input.
--
-- PRIVACY (invariant #2): PII-FREE by construction — opaque worker UUIDs, closed
-- vocabulary ids, integers, dates, one enum. NO employer name and NO per-job stint
-- (history is COARSE at launch, which is what keeps employer identity out of here).
--
-- DPDP ERASURE: both worker_id FKs are ON DELETE CASCADE, so the existing
-- single-statement hard delete (DELETE FROM workers WHERE id = $1, inside a txn —
-- apps/api WorkersRepository.hardDelete) erases these rows atomically. That code path
-- enumerates NO table names, so NO deletion-service change is needed for these tables.
--
-- LOCKS: CREATE TABLE only — no lock on any live table.
--
-- ROLLBACK — CONDITIONAL. CHECK BEFORE YOU DROP:
--   SELECT count(*) AS must_be_zero FROM worker_skill WHERE source <> 'derived_coarse';
--
-- `source` admits 'derived_coarse' | 'interview' | 'ops' (the CHECK below), and the D2
-- backfill owns ONLY 'derived_coarse' — it scopes both its upsert and its prune with
-- `setWhere source = 'derived_coarse'` so it can never overwrite a human-authored row.
-- So "re-derivable by re-running D2" is true of derived_coarse rows and FALSE of the
-- other two.
--
--   * count = 0 (the situation today — nothing writes 'interview'/'ops' yet; the only
--     intended writer, WorkerSkillsService.setWants, is an unwired seam that throws):
--     fully reversible, the data is 100% re-derivable by re-running D2 —
--       DROP TABLE "worker_skill";
--       DROP TABLE "worker_industry_tenure";
--
--   * count > 0: the unscoped DROP TABLE DESTROYS DATA NOTHING CAN REBUILD. Interview-
--     and ops-authored rows are a worker's own answers / an ops correction; no script
--     regenerates them. Do NOT drop. Undo only what D2 owns, keeping the table:
--       DELETE FROM worker_skill WHERE source = 'derived_coarse';
--       TRUNCATE worker_industry_tenure;   -- fully derived, D2 rebuilds it
--     Reversing this migration's DDL at that point requires exporting the surviving rows
--     first and accepting that restoring them is hand work, not a D2 re-run.
--
-- worker_industry_tenure has no `source` column and is 100% derived, so it is
-- rebuildable unconditionally.
--
-- Safe at any time before job_reach (0055) is populated; after that, drop job_reach
-- first (it has no FK to these, but a stale reach set would outlive its driver).
CREATE TABLE "worker_industry_tenure" (
	"worker_id" uuid NOT NULL,
	"industry_id" text NOT NULL,
	"calendar_months" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_industry_tenure_worker_id_industry_id_pk" PRIMARY KEY("worker_id","industry_id"),
	CONSTRAINT "worker_industry_tenure_months_nonneg_chk" CHECK ("worker_industry_tenure"."calendar_months" >= 0)
);
--> statement-breakpoint
ALTER TABLE "worker_industry_tenure" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "worker_skill" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"skill_id" text NOT NULL,
	"industry_id" text NOT NULL,
	"months_bucketed" integer DEFAULT 0 NOT NULL,
	"started_at" date,
	"ended_at" date,
	"wants" boolean DEFAULT true NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_skill_months_nonneg_chk" CHECK ("worker_skill"."months_bucketed" >= 0),
	CONSTRAINT "worker_skill_source_chk" CHECK ("worker_skill"."source" IN ('derived_coarse', 'interview', 'ops'))
);
--> statement-breakpoint
ALTER TABLE "worker_skill" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_industry_tenure" ADD CONSTRAINT "worker_industry_tenure_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_skill" ADD CONSTRAINT "worker_skill_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_skill" ADD CONSTRAINT "worker_skill_skill_id_skill_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "worker_skill_worker_skill_uq" ON "worker_skill" USING btree ("worker_id","skill_id");--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- THE REACH DRIVER INDEX. `INCLUDE ("worker_id","months_bucketed")` is HAND-APPENDED:
-- drizzle-kit 0.31 has no INCLUDE support (pg-core/indexes.d.ts IndexConfig), the same
-- modelling gap 0037 hit with NULLS NOT DISTINCT and handled the same way. The payload
-- makes both hot reads INDEX-ONLY (no heap fetch):
--   (a) the reach materialization  — WHERE skill_id = ANY($reach) AND wants
--   (b) the live reach COUNT for a posting
-- The 0053 snapshot records the non-INCLUDE form; name + key columns + WHERE all match,
-- so a future `db:generate` leaves this index alone (it will NOT emit a drop/recreate).
-- Do not "fix" the drift by regenerating — you would silently lose the payload.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX "worker_skill_reach_idx" ON "worker_skill" USING btree ("skill_id") INCLUDE ("worker_id","months_bucketed") WHERE "worker_skill"."wants";--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- Spine posture (ADR-0004 / TD20): FORCE RLS + REVOKE ALL for every Data-API role.
-- drizzle-kit emits ENABLE only (above). Both tables join back to worker identity, so
-- this is the exact linkage the spine exists to close. Registered in
-- tests/e2e/rls-spine.e2e.test.ts LOCKED_TABLES.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "worker_skill" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_skill" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_skill" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_skill" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_skill" FROM service_role;--> statement-breakpoint
ALTER TABLE "worker_industry_tenure" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_industry_tenure" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_industry_tenure" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_industry_tenure" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_industry_tenure" FROM service_role;