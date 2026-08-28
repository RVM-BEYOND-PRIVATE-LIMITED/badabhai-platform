-- R8 §5.1 — how many workers had a REAL interview whose extraction was thrown away?
--
-- THE DEFECT BEING COUNTED. `ExperienceEntry.work_done` was a required `str` and the model
-- returns `null` for an employment it could not describe. `experiences` is the only
-- list-of-objects in `InterviewExtractOutput`, so ONE null failed the whole `model_validate` and
-- `/profiling/extract` answered its own contract failure with a healthy 200 carrying an EMPTY
-- container and `is_mock=true`. Downstream that reads as "no interview happened": the API stores
-- `resume_profile: null` and the résumé silently falls back to the answer map.
--
-- Measured on the R7 personas, it hit 2 of 5 — costing one 22 skills and 2 employments, and the
-- other 24 skills and 3 employments. Fixed both ways (null coerced to "", plus an entry-tolerant
-- retry) in `1bb6b450`, but nothing repairs the rows written before that.
--
-- ── WHY `is_mock` IS NOT IN THIS QUERY ────────────────────────────────────────────────
--
-- It is not stored anywhere. The ai-service computes it as `is_mock = not meta.real_call` and
-- `profile-extraction.processor.ts` documents at length why it is deliberately NOT persisted or
-- keyed off: it is a REACHABILITY probe, true for every good deterministic extraction while
-- `AI_ENABLE_REAL_CALLS=false`, which is the committed default. So "count the profiles carrying
-- is_mock=true" has no column to read, and the question has to be asked structurally instead:
--
--     a real extraction call, a substantive interview behind it, and no interview overlay stored.
--
--   `ai_jobs.real_call = true`   the provider WAS reached — this was not a mocked environment
--   inbound message count        the worker actually answered; separates a discarded interview
--                                from a session nobody ever had
--   `raw_profile -> resume_profile` IS NULL   the overlay landed empty and was stored as nothing
--
-- FALSE POSITIVES ARE POSSIBLE AND ARE NOT SILENT. A genuinely `blocked` extraction (a
-- pseudonymisation failure) also stores a null overlay, and so does a deadline breach. Both are
-- rarer than this bug and both are worth finding anyway, so the query reports the population and
-- the operator reads `ai_jobs.output_ref` / `error_message` on the sample to split them. It is a
-- CANDIDATE COUNT, not a proven-defect count, and it is stated that way rather than presented as
-- a number.
--
-- ── HOW TO RUN IT ─────────────────────────────────────────────────────────────────────
--
--   psql "$DATABASE_URL" -f scripts/count-discarded-interviews.sql
--
-- READ-ONLY. No writes, no DDL, no PII in the output: worker ids and counts only, so the result
-- can be pasted into an issue. Identifying WHO is a second, deliberate step.

\set ON_ERROR_STOP on

-- Workers whose interview produced real inbound turns.
WITH interviewed AS (
  SELECT worker_id, COUNT(*) AS inbound_turns, MAX(created_at) AS last_turn
  FROM chat_messages
  WHERE direction = 'inbound'
    AND body_text IS NOT NULL
    AND length(trim(body_text)) > 0
  GROUP BY worker_id
),
-- Extraction jobs where a provider was ACTUALLY reached.
real_extractions AS (
  SELECT DISTINCT ON (input_ref ->> 'worker_id')
         (input_ref ->> 'worker_id')::uuid AS worker_id,
         id   AS ai_job_id,
         status,
         model_name,
         created_at
  FROM ai_jobs
  WHERE job_type = 'profile_extraction'
    AND real_call IS TRUE
    AND input_ref ->> 'worker_id' IS NOT NULL
  ORDER BY input_ref ->> 'worker_id', created_at DESC
),
profiles AS (
  SELECT DISTINCT ON (worker_id)
         worker_id,
         profile_status,
         raw_profile -> 'resume_profile' AS overlay,
         jsonb_array_length(COALESCE(raw_profile -> 'resume_profile' -> 'experiences', '[]')) AS n_exp,
         updated_at
  FROM worker_profiles
  ORDER BY worker_id, updated_at DESC
)
SELECT
  -- The population: a real extraction, a real interview, and nothing stored from it.
  COUNT(*) FILTER (
    WHERE p.overlay IS NULL OR p.overlay = 'null'::jsonb
  )                                                        AS discarded_candidates,
  -- The contrast rows, so the number above can be read rather than trusted.
  COUNT(*) FILTER (WHERE p.n_exp > 0)                      AS overlay_with_employments,
  COUNT(*) FILTER (
    WHERE p.overlay IS NOT NULL AND p.overlay <> 'null'::jsonb AND p.n_exp = 0
  )                                                        AS overlay_without_employments,
  COUNT(*)                                                 AS real_extractions_with_an_interview,
  MIN(i.inbound_turns)                                     AS min_turns,
  ROUND(AVG(i.inbound_turns), 1)                           AS mean_turns
FROM real_extractions r
JOIN interviewed i ON i.worker_id = r.worker_id
JOIN profiles    p ON p.worker_id = r.worker_id
-- FOUR TURNS is the floor for "he actually answered". `qp_universal` opens with the trade and
-- the city; a session that stopped before four inbound turns has almost nothing to discard, and
-- counting it would inflate the number with abandonment rather than with this defect.
WHERE i.inbound_turns >= 4;

-- The same population, per worker, for the repair list. Ids only — never a name or a number.
--
-- THE CTEs ARE REPEATED RATHER THAN SHARED because a `WITH` block is scoped to its own
-- statement; the first draft of this file put the listing in a second statement and psql failed
-- with `relation "real_extractions" does not exist` — after the count above had already printed,
-- which is the shape of failure that gets a number copied out of a half-failed run.
WITH interviewed AS (
  SELECT worker_id, COUNT(*) AS inbound_turns
  FROM chat_messages
  WHERE direction = 'inbound'
    AND body_text IS NOT NULL
    AND length(trim(body_text)) > 0
  GROUP BY worker_id
),
real_extractions AS (
  SELECT DISTINCT ON (input_ref ->> 'worker_id')
         (input_ref ->> 'worker_id')::uuid AS worker_id,
         id AS ai_job_id, status, model_name, created_at
  FROM ai_jobs
  WHERE job_type = 'profile_extraction'
    AND real_call IS TRUE
    AND input_ref ->> 'worker_id' IS NOT NULL
  ORDER BY input_ref ->> 'worker_id', created_at DESC
),
profiles AS (
  SELECT DISTINCT ON (worker_id)
         worker_id, profile_status, raw_profile -> 'resume_profile' AS overlay
  FROM worker_profiles
  ORDER BY worker_id, updated_at DESC
)
SELECT r.worker_id, i.inbound_turns, p.profile_status, r.model_name, r.created_at AS extracted_at
FROM real_extractions r
JOIN interviewed i ON i.worker_id = r.worker_id
JOIN profiles    p ON p.worker_id = r.worker_id
WHERE i.inbound_turns >= 4
  AND (p.overlay IS NULL OR p.overlay = 'null'::jsonb)
ORDER BY r.created_at DESC
LIMIT 200;
