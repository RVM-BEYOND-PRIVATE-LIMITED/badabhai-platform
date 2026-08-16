-- ===========================================================================
-- 0076 — CANONICAL DOMAIN -> SKILL TAXONOMY (Phase 1 of the taxonomy workstream)
--
-- Establishes one canonical `skill_id` space that travels worker -> profile -> employer ->
-- posting, and one canonical `job_domain_id` (`jd_*`) space on BOTH sides of the match.
--
-- FULLY ADDITIVE AND PERMISSIVE. Nothing is dropped, nothing is rewritten, no shipped
-- column changes meaning:
--   * three NEW tables, empty on arrival;
--   * four NEW nullable-or-defaulted columns on `skill_alias`;
--   * one NEW nullable column + FK on `job_postings`;
--   * two NOT NULL constraints RELAXED (`skill.domain_id`, `skill_alias.domain_id`).
--
-- Every ADD COLUMN is either nullable or has a constant DEFAULT, so each is metadata-only
-- on PG11+ — no table rewrite, no long lock, safe on live `skill_alias` / `job_postings`.
--
-- WHY THE TWO `DROP NOT NULL`s ARE THE CONSERVATIVE CHOICE, not the risky one. `skill`'s
-- 11 hand-minted domain slugs are disjoint from the 4,071-row `jd_*` catalogue. The
-- alternative to relaxing the constraint is to MAP the slugs onto `jd_*`, which ADR-0030
-- SG-5 defines as deprecate-and-recreate — it would invalidate all 66 live `skill_id`s and
-- every `worker_profiles.skills` / `job_postings.skill_ids` value referencing them. This
-- migration deliberately refuses that. `skill.domain_id` keeps every value it has and is
-- demoted to legacy metadata; the canonical relationship moves to `job_domain_skill`.
--
-- WHAT THIS MIGRATION DOES NOT DO — stated because their absence is a decision, not an
-- oversight:
--   * does NOT touch `worker_skill`. It stays the derived `mskill_*` projection that drives
--     `job_reach`, including its hand-appended INCLUDE payload on `worker_skill_reach_idx`
--     (which a schema change to that table would put at risk). Only its INPUT moves later.
--   * does NOT touch the four jsonb skill arrays on `job_postings`. `reach_skill_ids` is
--     GIN-indexed and load-bearing for feed reconciliation; the new relation lands
--     ALONGSIDE the arrays and the arrays stay authoritative for their existing readers.
--   * does NOT change ranking (invariant #4 / ADR-0036). `default_requirement` and
--     `requirement` are RECORDED and deliberately not consumed by the match engine; wiring
--     them into the rank key needs its own ADR + `engine_version` bump.
--   * does NOT make `skill_alias_embedding_hnsw` partial. Doing that today would unindex
--     all 131 live rows (`is_searchable` defaults false until the normalizer runs) and
--     silently degrade the shipped canonicalizer to a sequential scan.
--
-- ROLLBACK. Drop the three tables, drop the five added columns (which takes their indexes
-- and FKs with them), then restore the two NOT NULLs. The restore is the only ordered step:
-- it succeeds iff no NULL-domain `skill` / `skill_alias` row was written in the meantime,
-- so revert BEFORE the taxonomy bootstrap runs, or NULL those rows out first.
--   ALTER TABLE "skill" ALTER COLUMN "domain_id" SET NOT NULL;
--   ALTER TABLE "skill_alias" ALTER COLUMN "domain_id" SET NOT NULL;
--
-- MIGRATION SLOT. 0076 sits inside the `0075`-`0079` block MIGRATIONS.md records for
-- Prakash's OIE workstream. It is taken deliberately and not silently: that workstream's
-- own plan documents its nominal 0075/0076 claims being renumbered down to 0071/0072
-- (drizzle-kit assigns sequentially), 0075 itself was consumed by an unrelated job-search
-- change, no branch of the 86 on origin holds a 0076+ file, and CI enforces contiguous
-- prefixes so an unclaimed 0080 is not reachable. MIGRATIONS.md is updated in this same
-- change, including its stale head (it claimed 0071 / 72 entries against an actual 0075 / 76).
--
-- PII: none. `job_domain_skill` and `job_posting_skill` are pure reference/selection data.
-- `worker_profile_skill.evidence_ref` is contractually an OPAQUE INTERNAL ID (an
-- `ai_jobs.id`, a turn id) and never a transcript fragment — see the column comment in
-- src/schema/taxonomy.ts.
-- ===========================================================================
CREATE TABLE "job_domain_skill" (
	"job_domain_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"default_requirement" text DEFAULT 'preferred' NOT NULL,
	"relevance" smallint DEFAULT 50 NOT NULL,
	"confidence" real,
	"source" text NOT NULL,
	"inherited_from_job_domain_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_domain_skill_job_domain_id_skill_id_pk" PRIMARY KEY("job_domain_id","skill_id"),
	CONSTRAINT "job_domain_skill_requirement_chk" CHECK ("job_domain_skill"."default_requirement" IN ('required', 'preferred')),
	CONSTRAINT "job_domain_skill_source_chk" CHECK ("job_domain_skill"."source" IN ('llm_bootstrap', 'inherited', 'curated')),
	CONSTRAINT "job_domain_skill_status_chk" CHECK ("job_domain_skill"."status" IN ('active', 'provisional', 'deprecated')),
	CONSTRAINT "job_domain_skill_relevance_chk" CHECK ("job_domain_skill"."relevance" BETWEEN 0 AND 100),
	CONSTRAINT "job_domain_skill_confidence_chk" CHECK ("job_domain_skill"."confidence" IS NULL OR ("job_domain_skill"."confidence" >= 0 AND "job_domain_skill"."confidence" <= 1)),
	CONSTRAINT "job_domain_skill_inherited_from_chk" CHECK ("job_domain_skill"."inherited_from_job_domain_id" IS NULL OR "job_domain_skill"."source" = 'inherited'),
	CONSTRAINT "job_domain_skill_no_self_inherit_chk" CHECK ("job_domain_skill"."inherited_from_job_domain_id" IS NULL OR "job_domain_skill"."inherited_from_job_domain_id" <> "job_domain_skill"."job_domain_id")
);
--> statement-breakpoint
ALTER TABLE "job_domain_skill" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "job_posting_skill" (
	"job_posting_id" uuid NOT NULL,
	"skill_id" text NOT NULL,
	"requirement" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_posting_skill_job_posting_id_skill_id_pk" PRIMARY KEY("job_posting_id","skill_id"),
	CONSTRAINT "job_posting_skill_requirement_chk" CHECK ("job_posting_skill"."requirement" IN ('required', 'preferred')),
	CONSTRAINT "job_posting_skill_source_chk" CHECK ("job_posting_skill"."source" IN ('domain_default', 'employer_custom'))
);
--> statement-breakpoint
ALTER TABLE "job_posting_skill" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "worker_profile_skill" (
	"worker_profile_id" uuid NOT NULL,
	"skill_id" text NOT NULL,
	"confidence" real,
	"source" text NOT NULL,
	"evidence_ref" text,
	"months_experience" integer,
	"level" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_profile_skill_worker_profile_id_skill_id_pk" PRIMARY KEY("worker_profile_id","skill_id"),
	CONSTRAINT "worker_profile_skill_source_chk" CHECK ("worker_profile_skill"."source" IN ('llm_extraction', 'worker_confirmed', 'ops')),
	CONSTRAINT "worker_profile_skill_confidence_chk" CHECK ("worker_profile_skill"."confidence" IS NULL OR ("worker_profile_skill"."confidence" >= 0 AND "worker_profile_skill"."confidence" <= 1)),
	CONSTRAINT "worker_profile_skill_months_chk" CHECK ("worker_profile_skill"."months_experience" IS NULL OR "worker_profile_skill"."months_experience" >= 0),
	CONSTRAINT "worker_profile_skill_level_chk" CHECK ("worker_profile_skill"."level" IS NULL OR "worker_profile_skill"."level" IN ('beginner', 'intermediate', 'advanced'))
);
--> statement-breakpoint
ALTER TABLE "worker_profile_skill" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_alias" ALTER COLUMN "domain_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "skill" ALTER COLUMN "domain_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_alias" ADD COLUMN "text_norm" text;--> statement-breakpoint
ALTER TABLE "skill_alias" ADD COLUMN "is_searchable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_alias" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "skill_alias" ADD COLUMN "embedded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "job_domain_id" text;--> statement-breakpoint
ALTER TABLE "job_domain_skill" ADD CONSTRAINT "job_domain_skill_job_domain_id_job_domain_job_domain_id_fk" FOREIGN KEY ("job_domain_id") REFERENCES "public"."job_domain"("job_domain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_domain_skill" ADD CONSTRAINT "job_domain_skill_skill_id_skill_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_domain_skill" ADD CONSTRAINT "job_domain_skill_inherited_from_job_domain_id_job_domain_job_domain_id_fk" FOREIGN KEY ("inherited_from_job_domain_id") REFERENCES "public"."job_domain"("job_domain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_posting_skill" ADD CONSTRAINT "job_posting_skill_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_posting_skill" ADD CONSTRAINT "job_posting_skill_skill_id_skill_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_profile_skill" ADD CONSTRAINT "worker_profile_skill_worker_profile_id_worker_profiles_id_fk" FOREIGN KEY ("worker_profile_id") REFERENCES "public"."worker_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_profile_skill" ADD CONSTRAINT "worker_profile_skill_skill_id_skill_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_domain_skill_skill_id_idx" ON "job_domain_skill" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "job_domain_skill_inherited_from_idx" ON "job_domain_skill" USING btree ("inherited_from_job_domain_id");--> statement-breakpoint
CREATE INDEX "job_posting_skill_skill_id_idx" ON "job_posting_skill" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "worker_profile_skill_skill_id_idx" ON "worker_profile_skill" USING btree ("skill_id");--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_job_domain_id_job_domain_job_domain_id_fk" FOREIGN KEY ("job_domain_id") REFERENCES "public"."job_domain"("job_domain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_alias_text_norm_idx" ON "skill_alias" USING btree ("text_norm");--> statement-breakpoint
CREATE INDEX "skill_alias_text_norm_trgm_idx" ON "skill_alias" USING gin ("text_norm" gin_trgm_ops);--> statement-breakpoint
-- HAND-EDITED: `NULLS NOT DISTINCT` appended (PG15+), the same modelling gap 0037, 0067
-- and 0072 all hit and handled the same way — this drizzle version can express the clause
-- on a table CONSTRAINT but never on an INDEX. WITHOUT IT the guarantee is vacuous for the
-- rows that need it most: `lang` is nullable and most aliases carry NULL, and Postgres
-- treats every NULL as distinct, so two byte-identical aliases of one skill would both be
-- admitted. Documented at both ends (see `skill_alias_skill_norm_lang_uq` in
-- src/schema/skill.ts). If a future `db:generate` rewrites this line, re-append the clause.
--
-- The WHERE predicate is what makes this safe to add TODAY against live data: every
-- existing row has `is_searchable = false` (the column's default, added above in this same
-- migration), so no shipped row participates in the index and a pre-existing duplicate
-- cannot fail the CREATE. The normalizer runner elects one representative per
-- (skill_id, text_norm, lang) when it populates the two columns.
CREATE UNIQUE INDEX "skill_alias_skill_norm_lang_uq" ON "skill_alias" USING btree ("skill_id","text_norm","lang") NULLS NOT DISTINCT WHERE "skill_alias"."is_searchable";--> statement-breakpoint
CREATE INDEX "job_postings_job_domain_id_idx" ON "job_postings" USING btree ("job_domain_id");--> statement-breakpoint

-- ===========================================================================
-- HAND-APPENDED: spine posture (ADR-0004 / TD20) for the three new tables.
--
-- drizzle-kit emits ENABLE ROW LEVEL SECURITY only (above). FORCE + REVOKE are appended by
-- hand, exactly as 0052 did for `skill_related` and 0066 for the job-domain tables. No
-- policies exist on these tables, so with FORCE they are deny-by-default for every
-- client-facing Data-API role; the backend reaches them through the service-role
-- connection, which is what every other table in the spine already relies on.
--
-- This matters more than usual for `worker_profile_skill`: it is the first table to join a
-- worker's identity to a skill vocabulary, and it is read by matching. A permissive default
-- here would expose who-can-do-what across the whole worker base.
-- ===========================================================================
ALTER TABLE "job_domain_skill" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "job_domain_skill" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "job_domain_skill" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "job_domain_skill" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "job_domain_skill" FROM service_role;--> statement-breakpoint
ALTER TABLE "worker_profile_skill" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_profile_skill" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_profile_skill" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_profile_skill" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_profile_skill" FROM service_role;--> statement-breakpoint
ALTER TABLE "job_posting_skill" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "job_posting_skill" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "job_posting_skill" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "job_posting_skill" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "job_posting_skill" FROM service_role;