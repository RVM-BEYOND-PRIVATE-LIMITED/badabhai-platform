-- ===========================================================================
-- 0090 — Policy 27 third leg: reach-widen EXPIRY provenance (`job_reach_widen`).
--
-- TD127. The widen (service) and the audit/event (evented) halves of
-- "Ops may widen a reach set, never narrow one. Expiring, audited, evented."
-- already shipped; this migration ships the storage the expiry needs: ONE row per ops
-- widen request recording which `mskill_*` ids were appended, by which opaque actor,
-- and when the grant ends. The `reach-widen-expiry` sweep reads it as its authoritative
-- work list, retracts exactly the expired ids nothing else protects, re-materializes
-- the posting from its base set, and stamps `retracted_at`.
--
-- FULLY ADDITIVE AND REVERSIBLE (CLAUDE.md §10): one new table + two indexes. No
-- existing column, reader or writer changes; every row arrives empty-on-arrival and no
-- backfill exists or is wanted (nothing was widened before provenance existed).
-- Rollback:
--   DROP TABLE IF EXISTS "job_reach_widen";
--
-- WHY A PROVENANCE TABLE, NOT A TTL ON `job_reach`: a reach row is qualified by the
-- BEST skill across the whole set — there is no per-skill attribution to expire, and a
-- worker may be reachable through BOTH a base and a widened skill at once. Expiry must
-- live beside the system of record (`job_postings.reach_skill_ids`) or a retraction
-- could not restore it.
--
-- PRIVACY: ids, closed-vocabulary `mskill_*` ids and timestamps only. `ops_actor_id`
-- is the same opaque id the `job_posting.reach_widened` event carries (no FK, mirroring
-- `job_postings.created_by`). No worker data at all.
--
-- SPINE POSTURE: matches every Matching V1 table — ENABLE (drizzle-emitted above) plus
-- FORCE and four REVOKEs appended here, so only the service-role connection reads it.
SET lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE "job_reach_widen" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_posting_id" uuid NOT NULL,
	"added_skill_ids" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"retracted_at" timestamp with time zone,
	"ops_actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_reach_widen" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "job_reach_widen" ADD CONSTRAINT "job_reach_widen_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "job_reach_widen_due_idx" ON "job_reach_widen" USING btree ("expires_at") WHERE "job_reach_widen"."retracted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "job_reach_widen_posting_idx" ON "job_reach_widen" USING btree ("job_posting_id");
--> statement-breakpoint
ALTER TABLE "job_reach_widen" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "job_reach_widen" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON "job_reach_widen" FROM anon;
--> statement-breakpoint
REVOKE ALL ON "job_reach_widen" FROM authenticated;
--> statement-breakpoint
REVOKE ALL ON "job_reach_widen" FROM service_role;
