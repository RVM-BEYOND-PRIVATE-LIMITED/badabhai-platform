-- GET /jobs/search (#822): replace the seq-scanning ILIKE membership predicate
-- with a GIN-probed full-text vector.
--
-- ADDITIVE AND REVERSIBLE (CLAUDE.md §10). One IMMUTABLE helper function, one GENERATED
-- ALWAYS STORED tsvector column, one GIN index. No reader changes behaviour until
-- JobsRepository.searchOpenPostings flips to probe `search_vec`; the deterministic
-- relevance ladder (title prefix < title substring < skill-phrase-only) stays the same
-- SQL CASE it always was — §3: relevance is computed SQL, never a model score.
--
-- ROLLBACK, in this order:
--   DROP INDEX IF EXISTS "job_postings_search_gin";
--   ALTER TABLE "job_postings" DROP COLUMN IF EXISTS "search_vec";
--   DROP FUNCTION IF EXISTS job_postings_skill_phrases_text(jsonb);
-- Dropping the column alone reverts search to its pre-0089 shape.
--
-- WHY THE HELPER FUNCTION EXISTS. The phrase half of the vector comes from
-- `jsonb_array_elements_text(skill_phrases)`, a set-returning function, and Postgres
-- forbids set-returning functions AND subqueries inside a generated-column expression.
-- Wrapping the aggregation in a declared-IMMUTABLE SQL function is the standard,
-- semantically honest workaround: for any fixed jsonb input the output is fixed.
--
-- WHY CONFIG 'simple'. Posting text is Hinglish Roman script ("Fanuc CNC machine
-- operate karna", seed-jobs.ts) — an 'english' stemmer would corrupt the Hindi half of
-- every row. 'simple' case-folds and splits without stemming; suffix inflection is
-- handled at QUERY time with a prefix match (`term:*`), mirroring how the taxonomy
-- retrieval ladder already treats Roman-script Hindi.
--
-- PRIVACY. The vector derives from exactly the two NON-PII free-text columns search
-- already matched (`role_title`, `skill_phrases`). NEVER `location_label`,
-- `org_label` or `description`: employer identity stays off every worker-visible
-- structure (ADR-0024), and description was never searched.
--
-- LOCKS. `GENERATED … STORED` rewrites `job_postings` under ACCESS EXCLUSIVE for the
-- duration. At alpha scale (~dozens of postings) that is sub-second; `lock_timeout`
-- makes a contended apply fail fast instead of queueing behind traffic. If this ever
-- runs on a large table, take the 0022/0067 route: apply off-peak or hand-convert to
-- the CONCURRENTLY recipe in docs/perf/api-hot-paths.md.
SET lock_timeout = '3s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION job_postings_skill_phrases_text(phrases jsonb)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT coalesce(string_agg(p, ' '), '')
  FROM jsonb_array_elements_text(coalesce(phrases, '[]'::jsonb)) AS p
$fn$;
--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN IF NOT EXISTS "search_vec" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce("job_postings"."role_title", '')), 'A') || setweight(to_tsvector('simple', job_postings_skill_phrases_text("job_postings"."skill_phrases")), 'B')) STORED;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_postings_search_gin" ON "job_postings" USING gin ("search_vec");
