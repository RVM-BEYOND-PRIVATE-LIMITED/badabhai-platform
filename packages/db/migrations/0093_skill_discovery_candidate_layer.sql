-- ===========================================================================
-- 0093 — SKILL DISCOVERY & CURATION: the candidate staging layer
--
-- Four NEW, EMPTY tables. Nothing existing is touched: no column is added, dropped,
-- renamed or re-typed on any shipped table, no constraint is relaxed, no index is
-- rebuilt. The migration is therefore additive in the strongest sense — rollback is
-- four DROP TABLEs and the database is byte-identical to 0092.
--
-- ===========================================================================
-- WHAT THIS IS FOR
-- ===========================================================================
-- `job_domain_alias` holds 9,121 rows of published occupation vocabulary (measured
-- 2026-08-26). Somewhere inside them is evidence of skills the canonical `skill` table
-- does not carry. Finding that evidence needs normalization, clustering, similarity
-- scoring and a model — and every one of those steps produces a GUESS.
--
-- These tables are where guesses live, and they are deliberately NOT `skill` and NOT
-- `skill_alias`. A row here has no path into the production vocabulary except through a
-- named admin's recorded decision and then through the gates the taxonomy corpus pipeline
-- already enforces (validateTaxonomyCorpus -> taxonomyQualityVerdict -> human commit ->
-- db:seed:domain-skills -> db:promote:skills C1..C5). This migration adds no shortcut to
-- any of that and removes nothing from it.
--
--     skill_discovery_run  1 --< skill_candidate  1 --< skill_candidate_source
--                                       |
--                                       +--< skill_candidate_match
--
-- ===========================================================================
-- FOUR CONSTRAINTS CARRY THE SAFETY PROPERTIES
-- ===========================================================================
--   skill_candidate_reviewed_chk          a human decision names the human, the moment AND
--                                         the reason, or the row is refused. The audit trail
--                                         is a property of the database, not a promise made
--                                         by whichever service wrote the row.
--   skill_candidate_machine_status_chk    the inverse: a 'pending'/'needs_review' row may not
--                                         carry a reviewer, because that claims a decision
--                                         nobody made.
--   skill_candidate_not_match_skill_chk   ) the Phase-12 wall, stated at BOTH ends. `mskill_*`
--   skill_candidate_match_not_match_...   ) is a closed, CEO-ratified 18-member vocabulary the
--                                         deterministic match engine consumes. Discovery may
--                                         never resolve onto it, nor even OFFER one as an
--                                         option to a reviewer — CLAUDE.md §3: an LLM must
--                                         never author ranking vocabulary.
--
-- ===========================================================================
-- THE REVIEWER NAMES THE TRADES, BECAUSE THE PIPELINE MAY NOT
-- ===========================================================================
-- `skill_candidate.approved_job_domain_ids` + `approved_requirement` exist because
-- `validateTaxonomyCorpus` refuses a skill with zero `job_domain_skill` edges (SKILL_ORPHAN:
-- *"it seeds, it embeds, and it is invisible"*). The first draft of the export path emitted no
-- edges on the grounds that discovery must not INFER what a trade requires -- and every batch
-- it produced was therefore permanently BLOCKED. The validator was right; the design was wrong.
--
-- The resolution is neither to infer the edge nor to weaken the gate: it is to ask the human
-- who is already looking at the answer. The review screen shows the candidate's SOURCE
-- OCCUPATIONS, and the reviewer accepts, trims, or replaces them. That is exactly the judgement
-- `job_domain_skill.source = 'curated'` already represents, so no new enum value and no second
-- migration is needed.
--
-- `skill_candidate_create_domain_chk` is the database half of that argument: an `approved_create`
-- row must name at least one trade. Enforced here rather than only in the service, so a row
-- written by a backfill, a fixture, or a future runner is subject to the same rule.
--
-- The array carries NO foreign key -- Postgres cannot key an array element -- so it is validated
-- at both ends instead: the admin service resolves every id against `job_domain` before
-- recording the decision, and `seed-domain-skills.ts` re-checks the corpus's domains against
-- the live catalogue before writing anything.
--
-- WHAT IS DELIBERATELY ABSENT, because absence here is a decision:
--   * NO threshold column, trigger or default that moves `status` toward approval because a
--     similarity number crossed a line. This repository has already measured false semantic
--     matches (ducting_installation -> plumber, split_unit_installation -> fitter). Similarity
--     is EVIDENCE; it is never authorization.
--   * NO `best_match_skill_id` column. Competing matches live in `skill_candidate_match`,
--     plural, so a reviewer sees the competition a single winner column would have hidden.
--   * NO `worker_id` anywhere. Same aggregate-only contract `unresolved_phrase` holds: this
--     must not become a per-worker DSAR surface.
--   * NO writer for `skill`, `skill_alias` or `job_domain_skill`. This layer proposes.
--
-- ===========================================================================
-- PRIVACY
-- ===========================================================================
-- `skill_candidate_source.original_text` is the one column that can carry worker free text,
-- and for the `worker_phrase` source type it is contractually PSEUDONYMIZED upstream (the
-- ai-service pseudonymizer, fail-closed — `mine-chat-aliases.ts` is the reference). The
-- discovery classifier additionally refuses any phrase carrying a digit, '@' or a URL before
-- it can become a source row, so a contact detail that survived pseudonymization still
-- cannot land here.
--
-- ===========================================================================
-- ROLLBACK
-- ===========================================================================
--   DROP TABLE "skill_candidate_match";
--   DROP TABLE "skill_candidate_source";
--   DROP TABLE "skill_candidate";
--   DROP TABLE "skill_discovery_run";
-- In that order (children first). No other statement is needed — nothing outside these four
-- tables was changed.
--
-- MIGRATION SLOT. 0093 follows 0092, which is the applied head
-- (drizzle.__drizzle_migrations created_at = 1787650702334 == 0092_flawless_glorian.when,
-- verified 2026-08-26). No branch holds a 0093.
-- ===========================================================================
CREATE TABLE "skill_candidate_match" (
	"candidate_id" uuid NOT NULL,
	"skill_id" text NOT NULL,
	"relation" text NOT NULL,
	"score" real NOT NULL,
	"strength" text NOT NULL,
	"rank" smallint NOT NULL,
	"evidence_detail" text,
	CONSTRAINT "skill_candidate_match_candidate_id_skill_id_pk" PRIMARY KEY("candidate_id","skill_id"),
	CONSTRAINT "skill_candidate_match_strength_chk" CHECK ("skill_candidate_match"."strength" IN ('strong', 'weak')),
	CONSTRAINT "skill_candidate_match_score_chk" CHECK ("skill_candidate_match"."score" >= 0 AND "skill_candidate_match"."score" <= 1),
	CONSTRAINT "skill_candidate_match_rank_chk" CHECK ("skill_candidate_match"."rank" >= 1),
	CONSTRAINT "skill_candidate_match_not_match_skill_chk" CHECK ("skill_candidate_match"."skill_id" NOT LIKE 'mskill\_%')
);
--> statement-breakpoint
ALTER TABLE "skill_candidate_match" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "skill_candidate_source" (
	"candidate_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"original_text" text NOT NULL,
	"normalized_text" text NOT NULL,
	"job_domain_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_candidate_source_candidate_id_source_type_source_id_pk" PRIMARY KEY("candidate_id","source_type","source_id"),
	CONSTRAINT "skill_candidate_source_type_chk" CHECK ("skill_candidate_source"."source_type" IN ('job_domain_alias', 'job_domain_label', 'unresolved_phrase', 'worker_phrase', 'job_text', 'skill_alias'))
);
--> statement-breakpoint
ALTER TABLE "skill_candidate_source" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "skill_candidate" (
	"candidate_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" text NOT NULL,
	"cluster_key" text NOT NULL,
	"normalized_phrase" text NOT NULL,
	"proposed_skill_name" text,
	"proposed_description" text,
	"phrase_class" text NOT NULL,
	"classifier_rule" text NOT NULL,
	"occupation_heads" text[] DEFAULT '{}'::text[] NOT NULL,
	"evidence_tokens" text[] DEFAULT '{}'::text[] NOT NULL,
	"trade_family" text,
	"source_alias_count" integer DEFAULT 0 NOT NULL,
	"source_domain_count" integer DEFAULT 0 NOT NULL,
	"proposed_action" text DEFAULT 'review' NOT NULL,
	"confidence_band" text DEFAULT 'low' NOT NULL,
	"confidence" real,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewer_admin_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_reason" text,
	"approved_job_domain_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"approved_requirement" text DEFAULT 'preferred' NOT NULL,
	"resulting_skill_id" text,
	"embedding_status" text DEFAULT 'not_required' NOT NULL,
	"model" text,
	"prompt_version" text,
	"corpus_fingerprint" text NOT NULL,
	"provenance_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_candidate_status_chk" CHECK ("skill_candidate"."status" IN ('pending', 'needs_review', 'approved_create', 'approved_map', 'approved_merge', 'rejected', 'deferred')),
	CONSTRAINT "skill_candidate_action_chk" CHECK ("skill_candidate"."proposed_action" IN ('map', 'create', 'merge', 'reject', 'review')),
	CONSTRAINT "skill_candidate_band_chk" CHECK ("skill_candidate"."confidence_band" IN ('high', 'medium', 'low')),
	CONSTRAINT "skill_candidate_embedding_status_chk" CHECK ("skill_candidate"."embedding_status" IN ('reused', 'needs_embedding', 'not_required')),
	CONSTRAINT "skill_candidate_confidence_range_chk" CHECK ("skill_candidate"."confidence" IS NULL OR ("skill_candidate"."confidence" >= 0 AND "skill_candidate"."confidence" <= 1)),
	CONSTRAINT "skill_candidate_model_pair_chk" CHECK (("skill_candidate"."model" IS NULL) = ("skill_candidate"."prompt_version" IS NULL)),
	CONSTRAINT "skill_candidate_reviewed_chk" CHECK ("skill_candidate"."status" NOT IN ('approved_create', 'approved_map', 'approved_merge', 'rejected', 'deferred')
           OR ("skill_candidate"."reviewer_admin_id" IS NOT NULL AND "skill_candidate"."reviewed_at" IS NOT NULL AND "skill_candidate"."review_reason" IS NOT NULL)),
	CONSTRAINT "skill_candidate_machine_status_chk" CHECK ("skill_candidate"."status" NOT IN ('pending', 'needs_review') OR "skill_candidate"."reviewer_admin_id" IS NULL),
	CONSTRAINT "skill_candidate_resolution_chk" CHECK ("skill_candidate"."status" NOT IN ('approved_map', 'approved_merge') OR "skill_candidate"."resulting_skill_id" IS NOT NULL),
	CONSTRAINT "skill_candidate_create_label_chk" CHECK ("skill_candidate"."status" <> 'approved_create' OR "skill_candidate"."proposed_skill_name" IS NOT NULL),
	CONSTRAINT "skill_candidate_create_domain_chk" CHECK ("skill_candidate"."status" <> 'approved_create' OR array_length("skill_candidate"."approved_job_domain_ids", 1) >= 1),
	CONSTRAINT "skill_candidate_requirement_chk" CHECK ("skill_candidate"."approved_requirement" IN ('required', 'preferred')),
	CONSTRAINT "skill_candidate_not_match_skill_chk" CHECK ("skill_candidate"."resulting_skill_id" IS NULL OR "skill_candidate"."resulting_skill_id" NOT LIKE 'mskill\_%')
);
--> statement-breakpoint
ALTER TABLE "skill_candidate" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "skill_discovery_run" (
	"run_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"input_fingerprint" text NOT NULL,
	"config_json" text,
	"source_count" integer DEFAULT 0 NOT NULL,
	"normalized_count" integer DEFAULT 0 NOT NULL,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"cluster_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"model" text,
	"prompt_version" text,
	"embedding_model" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "skill_discovery_run_status_chk" CHECK ("skill_discovery_run"."status" IN ('running', 'completed', 'failed')),
	CONSTRAINT "skill_discovery_run_model_pair_chk" CHECK (("skill_discovery_run"."model" IS NULL) = ("skill_discovery_run"."prompt_version" IS NULL)),
	CONSTRAINT "skill_discovery_run_completed_chk" CHECK ("skill_discovery_run"."status" = 'running' OR "skill_discovery_run"."completed_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "skill_discovery_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_candidate_match" ADD CONSTRAINT "skill_candidate_match_candidate_id_skill_candidate_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."skill_candidate"("candidate_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_candidate_match" ADD CONSTRAINT "skill_candidate_match_skill_id_skill_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_candidate_source" ADD CONSTRAINT "skill_candidate_source_candidate_id_skill_candidate_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."skill_candidate"("candidate_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_candidate_source" ADD CONSTRAINT "skill_candidate_source_job_domain_id_job_domain_job_domain_id_fk" FOREIGN KEY ("job_domain_id") REFERENCES "public"."job_domain"("job_domain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_candidate" ADD CONSTRAINT "skill_candidate_run_id_skill_discovery_run_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."skill_discovery_run"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_candidate" ADD CONSTRAINT "skill_candidate_reviewer_admin_id_admin_users_id_fk" FOREIGN KEY ("reviewer_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_candidate" ADD CONSTRAINT "skill_candidate_resulting_skill_id_skill_skill_id_fk" FOREIGN KEY ("resulting_skill_id") REFERENCES "public"."skill"("skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_candidate_match_skill_idx" ON "skill_candidate_match" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "skill_candidate_source_source_idx" ON "skill_candidate_source" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "skill_candidate_source_job_domain_idx" ON "skill_candidate_source" USING btree ("job_domain_id");--> statement-breakpoint
CREATE INDEX "skill_candidate_source_norm_idx" ON "skill_candidate_source" USING btree ("normalized_text");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_candidate_run_cluster_uq" ON "skill_candidate" USING btree ("run_id","cluster_key");--> statement-breakpoint
CREATE INDEX "skill_candidate_queue_idx" ON "skill_candidate" USING btree ("status","confidence_band","source_domain_count");--> statement-breakpoint
CREATE INDEX "skill_candidate_run_id_idx" ON "skill_candidate" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "skill_candidate_resulting_skill_idx" ON "skill_candidate" USING btree ("resulting_skill_id");--> statement-breakpoint
CREATE INDEX "skill_candidate_reviewer_idx" ON "skill_candidate" USING btree ("reviewer_admin_id");--> statement-breakpoint
CREATE INDEX "skill_candidate_family_idx" ON "skill_candidate" USING btree ("trade_family");--> statement-breakpoint
CREATE INDEX "skill_discovery_run_status_idx" ON "skill_discovery_run" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "skill_discovery_run_fingerprint_idx" ON "skill_discovery_run" USING btree ("input_fingerprint");

-- ===========================================================================
-- HAND-APPENDED: spine posture (ADR-0004 / TD20) for the four new tables.
--
-- drizzle-kit emits ENABLE ROW LEVEL SECURITY only (above). FORCE + REVOKE are appended by
-- hand, exactly as 0052 did for `skill_related`, 0066 for the job-domain tables and 0076 for
-- the canonical taxonomy tables. No policies exist on these tables, so with FORCE they are
-- deny-by-default for every client-facing Data-API role; the backend reaches them through the
-- owner connection, which is what the rest of the spine already relies on.
--
-- Note also 0088's `rls_auto_enable` event trigger, which fires on every CREATE TABLE in
-- `public` and applies the same three conditions. These statements are therefore expected to
-- be idempotent no-ops on a database where that trigger is live. They are written out anyway:
-- the trigger exists in exactly one environment's catalogue and a migration that depends on it
-- would silently ship unlocked tables anywhere it does not.
-- ===========================================================================
ALTER TABLE "skill_discovery_run" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "skill_discovery_run" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "skill_discovery_run" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "skill_discovery_run" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "skill_discovery_run" FROM service_role;--> statement-breakpoint
ALTER TABLE "skill_candidate" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "skill_candidate" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "skill_candidate" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "skill_candidate" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "skill_candidate" FROM service_role;--> statement-breakpoint
ALTER TABLE "skill_candidate_source" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "skill_candidate_source" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "skill_candidate_source" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "skill_candidate_source" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "skill_candidate_source" FROM service_role;--> statement-breakpoint
ALTER TABLE "skill_candidate_match" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "skill_candidate_match" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "skill_candidate_match" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "skill_candidate_match" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "skill_candidate_match" FROM service_role;
