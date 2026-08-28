-- Seed data for `scripts/count-discarded-interviews.sql` (R12 §4.2).
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- THE RULE THIS FILE EXISTS TO OBEY: a detector's fixture must contain the thing the detector
-- detects.
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- The first validation of that query ran against three workers, NONE of whom had a discarded
-- interview. It returned zero, and zero was consistent with two different worlds — a query that
-- works and finds nothing, and the query that actually shipped, which gated on
-- `ai_jobs.real_call` and could not have found anything. The number carried its command; the
-- command could not answer the question.
--
-- So three rows, each named for the thing it proves:
--
--   POSITIVE  a worker who was really interviewed, whose extraction really ran, and whose
--             overlay is NULL. He is what the query counts. Without him a green run means
--             nothing.
--   NEGATIVE  the same shape with an overlay that landed. He must NOT be counted, or a query
--             that returns every row would look identical to a correct one.
--   DECOY     a `profile_parse` trace with `real_call = false`, on a fourth worker with no
--             `profile_extraction` trace at all. This is the row the OLD filter matched and the
--             new one must ignore. It is the difference between the two versions, made visible.
--
-- Also seeded: a worker with a real extraction and only THREE inbound turns, to exercise the
-- `inbound_turns >= 4` floor. Abandonment is not this defect and must not inflate the count.
--
-- HOW TO RUN, against an isolated database — NEVER production:
--     psql "$BB_VERIFY_URL" -f apps/ai-service/tests/fixtures/discarded_interviews.sql
--     psql "$BB_VERIFY_URL" -f scripts/count-discarded-interviews.sql
--
-- EXPECTED, and this is the assertion:
--     discarded_candidates                = 1     (only w_positive)
--     overlay_with_employments            = 1     (only w_negative)
--     real_extractions_with_an_interview  = 2     (the decoy and the 3-turn worker excluded)
--
-- PII: every value below is synthetic. The phone numbers are in the 555 test range and the
-- transcript text is invented. Nothing here is a real worker.

BEGIN;

-- Idempotent: this file is meant to be re-runnable while iterating on the query.
DELETE FROM ai_call_traces  WHERE worker_id IN (
  '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444');
DELETE FROM chat_messages   WHERE worker_id IN (
  '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444');
DELETE FROM worker_profiles WHERE worker_id IN (
  '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444');

-- ── POSITIVE ────────────────────────────────────────────────────────────────────────────────
-- Interviewed (5 inbound turns), extraction really ran, overlay is NULL. THE ROW THE QUERY
-- EXISTS TO FIND. A run that reports 0 while this row is present is the broken query.
INSERT INTO chat_messages (id, worker_id, direction, body_text, created_at) VALUES
  (gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 'inbound', 'CNC lathe chalata hoon sir', now()),
  (gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 'inbound', 'Do saal ho gaye', now()),
  (gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 'inbound', 'Fanuc control hai', now()),
  (gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 'inbound', 'Vernier aur micrometer', now()),
  (gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 'inbound', 'Faridabad me rehta hoon', now());
INSERT INTO ai_call_traces (id, worker_id, task_type, real_call, model_name, created_at) VALUES
  (gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 'profile_extraction', true, 'gemini-2.5-flash', now());
INSERT INTO worker_profiles (id, worker_id, profile_status, raw_profile, updated_at) VALUES
  (gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 'draft', '{"resume_profile": null}'::jsonb, now());

-- ── NEGATIVE ────────────────────────────────────────────────────────────────────────────────
-- Same shape, overlay landed with an employment. Must NOT be counted as discarded — otherwise a
-- query matching everything is indistinguishable from a correct one.
INSERT INTO chat_messages (id, worker_id, direction, body_text, created_at) VALUES
  (gen_random_uuid(), '22222222-2222-4222-8222-222222222222', 'inbound', 'VMC operator hoon', now()),
  (gen_random_uuid(), '22222222-2222-4222-8222-222222222222', 'inbound', 'Aath saal ka experience', now()),
  (gen_random_uuid(), '22222222-2222-4222-8222-222222222222', 'inbound', 'Siemens control', now()),
  (gen_random_uuid(), '22222222-2222-4222-8222-222222222222', 'inbound', 'Gurugram', now());
INSERT INTO ai_call_traces (id, worker_id, task_type, real_call, model_name, created_at) VALUES
  (gen_random_uuid(), '22222222-2222-4222-8222-222222222222', 'profile_extraction', true, 'gemini-2.5-flash', now());
INSERT INTO worker_profiles (id, worker_id, profile_status, raw_profile, updated_at) VALUES
  (gen_random_uuid(), '22222222-2222-4222-8222-222222222222', 'extracted',
   '{"resume_profile": {"experiences": [{"role_label": "VMC Operator"}]}}'::jsonb, now());

-- ── DECOY ───────────────────────────────────────────────────────────────────────────────────
-- A `profile_parse` trace with `real_call = false`, and NO `profile_extraction` trace. This is
-- exactly what the shipped-then-fixed `ai_jobs.real_call IS TRUE` filter keyed on. The corrected
-- query must exclude him — he is not evidence of a discarded interview, he is the artefact that
-- made the old query look like it was working.
INSERT INTO chat_messages (id, worker_id, direction, body_text, created_at) VALUES
  (gen_random_uuid(), '33333333-3333-4333-8333-333333333333', 'inbound', 'Welding karta hoon', now()),
  (gen_random_uuid(), '33333333-3333-4333-8333-333333333333', 'inbound', 'Paanch saal', now()),
  (gen_random_uuid(), '33333333-3333-4333-8333-333333333333', 'inbound', 'MIG aur TIG', now()),
  (gen_random_uuid(), '33333333-3333-4333-8333-333333333333', 'inbound', 'Rajkot', now());
INSERT INTO ai_call_traces (id, worker_id, task_type, real_call, model_name, created_at) VALUES
  (gen_random_uuid(), '33333333-3333-4333-8333-333333333333', 'profile_parse', false, 'gemini-2.5-flash', now());
INSERT INTO worker_profiles (id, worker_id, profile_status, raw_profile, updated_at) VALUES
  (gen_random_uuid(), '33333333-3333-4333-8333-333333333333', 'draft', '{"resume_profile": null}'::jsonb, now());

-- ── THE TURN FLOOR ──────────────────────────────────────────────────────────────────────────
-- A real extraction, a null overlay, and only THREE inbound turns. Excluded by
-- `inbound_turns >= 4`, because a session that stopped that early had almost nothing to discard
-- and counting it would report abandonment as this defect.
INSERT INTO chat_messages (id, worker_id, direction, body_text, created_at) VALUES
  (gen_random_uuid(), '44444444-4444-4444-8444-444444444444', 'inbound', 'Fitter', now()),
  (gen_random_uuid(), '44444444-4444-4444-8444-444444444444', 'inbound', 'Teen saal', now()),
  (gen_random_uuid(), '44444444-4444-4444-8444-444444444444', 'inbound', 'Pune', now());
INSERT INTO ai_call_traces (id, worker_id, task_type, real_call, model_name, created_at) VALUES
  (gen_random_uuid(), '44444444-4444-4444-8444-444444444444', 'profile_extraction', true, 'gemini-2.5-flash', now());
INSERT INTO worker_profiles (id, worker_id, profile_status, raw_profile, updated_at) VALUES
  (gen_random_uuid(), '44444444-4444-4444-8444-444444444444', 'draft', '{"resume_profile": null}'::jsonb, now());

COMMIT;

-- END
