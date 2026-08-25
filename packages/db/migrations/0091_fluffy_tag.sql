-- ===========================================================================
-- 0091 — LEARN label store: real-event training labels for `@badabhai/reach-learn`.
--
-- The reach-learn eval ran on SYNTHETIC data because zero real feed/application events
-- had ever been captured into a trainable shape (docs/reach/learn-layer-eval-results.md).
-- The events exist on the spine; this migration adds their per-IMPRESSION projection:
--
--   learn_labels        one row per SERVED feed card (`feed.shown_v2`), resolved to
--                       'applied'/'skipped' when a later application event decides it,
--                       'none' (= weak negative) otherwise. Carries rank / match_tier /
--                       boosted / matched_skill_id AT SHOW TIME — the context a
--                       learning-to-rank label needs and `applications` never kept.
--   learn_labels_cursor single-row sweep watermark over `events.created_at`. Idempotency
--                       lives in the UNIQUE impression key + the pending-resolution
--                       guard, so the cursor is an optimization, not a correctness crutch.
--
-- FULLY ADDITIVE AND REVERSIBLE (CLAUDE.md §10): two new tables, empty-on-arrival, no
-- backfill (there is nothing historical to project — labeling starts from deploy).
-- Rollback:
--   DROP TABLE IF EXISTS "learn_labels_cursor";
--   DROP TABLE IF EXISTS "learn_labels";
--
-- PRIVACY: opaque ids, closed-vocabulary mskill_* ids, booleans and integers only — the
-- exact field set of the registry-validated FeedShownV2/Application payloads. No free
-- text exists anywhere in this table.
--
-- DPDP: worker_id CASCADEs from workers, so the DSAR hard delete erases labels with the
-- same statement that erases everything else about the worker. No new deletion path.
--
-- SPINE POSTURE: ENABLE (drizzle-emitted) + FORCE + four REVOKEs appended here, matching
-- every Matching V1 table — service-role connections only.
SET lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE "learn_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"job_posting_id" uuid NOT NULL,
	"impression_event_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"match_tier" smallint NOT NULL,
	"boosted" boolean DEFAULT false NOT NULL,
	"matched_skill_id" text NOT NULL,
	"outcome" text DEFAULT 'none' NOT NULL,
	"outcome_event_id" uuid,
	"skip_reason" text,
	"label" smallint DEFAULT 0 NOT NULL,
	"shown_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learn_labels_outcome_chk" CHECK ("learn_labels"."outcome" IN ('none', 'applied', 'skipped')),
	CONSTRAINT "learn_labels_label_chk" CHECK ("learn_labels"."label" IN (0, 1)),
	CONSTRAINT "learn_labels_rank_chk" CHECK ("learn_labels"."rank" >= 1),
	CONSTRAINT "learn_labels_tier_chk" CHECK ("learn_labels"."match_tier" IN (1, 2)),
	CONSTRAINT "learn_labels_skip_reason_chk" CHECK (("learn_labels"."skip_reason" IS NULL AND "learn_labels"."outcome" <> 'skipped') OR ("learn_labels"."skip_reason" IS NOT NULL AND "learn_labels"."outcome" = 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "learn_labels" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "learn_labels_cursor" (
	"id" text PRIMARY KEY NOT NULL,
	"watermark" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "learn_labels_cursor" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "learn_labels" ADD CONSTRAINT "learn_labels_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "learn_labels" ADD CONSTRAINT "learn_labels_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "learn_labels_impression_uq" ON "learn_labels" USING btree ("impression_event_id");
--> statement-breakpoint
CREATE INDEX "learn_labels_resolve_idx" ON "learn_labels" USING btree ("worker_id","job_posting_id");
--> statement-breakpoint
CREATE INDEX "learn_labels_shown_at_idx" ON "learn_labels" USING btree ("shown_at");
--> statement-breakpoint
ALTER TABLE "learn_labels" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "learn_labels" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON "learn_labels" FROM anon;
--> statement-breakpoint
REVOKE ALL ON "learn_labels" FROM authenticated;
--> statement-breakpoint
REVOKE ALL ON "learn_labels" FROM service_role;
--> statement-breakpoint
ALTER TABLE "learn_labels_cursor" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "learn_labels_cursor" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON "learn_labels_cursor" FROM anon;
--> statement-breakpoint
REVOKE ALL ON "learn_labels_cursor" FROM authenticated;
--> statement-breakpoint
REVOKE ALL ON "learn_labels_cursor" FROM service_role;
