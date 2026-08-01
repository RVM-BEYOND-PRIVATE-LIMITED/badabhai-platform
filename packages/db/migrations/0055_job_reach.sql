-- Matching V1 — step 4 of 7: `job_reach`, the reach set MATERIALIZED ON WRITE.
--
-- EXPAND-ONLY: one NEW table. Nothing existing is touched. Until
-- `db:materialize:reach` (D5) runs, the table is empty and no read path exists yet.
--
-- WHAT IT IS: one row per (posting, worker) the posting can reach, with the TIER and the
-- skill that earned it. It is a CACHE — every row is reproducible from
-- job_postings.reach_skill_ids × worker_skill, so TRUNCATE costs a rebuild, never data.
--
-- TIER (E6, best-tier-wins): 1 = the worker holds a skill the poster actually asked for;
-- 2 = reached only through a skill_related neighbour. A worker who qualifies both ways
-- is TIER 1 (the materializer's MIN() decides). CHECK pins the domain to (1, 2).
--
-- PRIVACY (invariant #2): PII-FREE — two opaque UUIDs, a smallint, one closed-vocabulary
-- skill id, a timestamp. worker_id → workers is the only join back to identity (same
-- shape as `applications` since ADR-0009).
--
-- DPDP ERASURE: worker_id CASCADEs from workers (a deleted worker leaves every reach set
-- atomically, via the existing single-statement hard delete — NO deletion-service
-- change) and job_posting_id CASCADEs from job_postings.
--
-- SIZING NOTE for the applier: this is the widest table in the system by row count
-- (open postings × reachable workers). Watch it after the first D5 run; the covering
-- index below is what keeps the feed read off the heap.
--
-- LOCKS: CREATE TABLE only — no lock on any live table.
--
-- ROLLBACK (fully reversible, zero data loss — it is a rebuildable cache):
--   DROP TABLE "job_reach";
CREATE TABLE "job_reach" (
	"job_posting_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"match_tier" smallint NOT NULL,
	"matched_skill_id" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_reach_job_posting_id_worker_id_pk" PRIMARY KEY("job_posting_id","worker_id"),
	CONSTRAINT "job_reach_match_tier_chk" CHECK ("job_reach"."match_tier" IN (1, 2))
);
--> statement-breakpoint
ALTER TABLE "job_reach" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job_reach" ADD CONSTRAINT "job_reach_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_reach" ADD CONSTRAINT "job_reach_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_reach" ADD CONSTRAINT "job_reach_matched_skill_id_skill_skill_id_fk" FOREIGN KEY ("matched_skill_id") REFERENCES "public"."skill"("skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- THE FEED COVERING INDEX. `INCLUDE (...)` is HAND-APPENDED — drizzle-kit 0.31 has no
-- INCLUDE support (same gap + same handling as worker_skill_reach_idx in 0053 and
-- NULLS NOT DISTINCT in 0037). The feed read is `WHERE worker_id = $1`, and the PK is
-- (job_posting_id, worker_id) so it CANNOT serve a worker-leading lookup — this index
-- is genuinely required, not a duplicate of the PK. With the payload the whole feed page
-- is an index-only scan. Regenerating over this line silently drops the payload; don't.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX "job_reach_worker_idx" ON "job_reach" USING btree ("worker_id") INCLUDE ("job_posting_id","match_tier","matched_skill_id");--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- Spine posture (ADR-0004 / TD20): FORCE RLS + REVOKE ALL for every Data-API role.
-- drizzle-kit emits ENABLE only (above). Registered in
-- tests/e2e/rls-spine.e2e.test.ts LOCKED_TABLES.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "job_reach" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "job_reach" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "job_reach" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "job_reach" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "job_reach" FROM service_role;