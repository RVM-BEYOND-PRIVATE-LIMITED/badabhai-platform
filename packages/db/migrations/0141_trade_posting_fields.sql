-- 0141 — the trade-specific posting form (16 live trades).
--
-- WHY. The posting form collected a role title and a flat match-skill pick, so the
-- fields the CEO launch pack defines per trade (machines, controllers, operations,
-- materials, tolerances, sectors, programming depth, inspection work …) had nowhere
-- to live. The worker side already stores those answers on `worker_attributes`; the
-- posting side could not state the same facts, and the employer candidate list could
-- not use them as facets.
--
-- WHAT IS STORED.
--   * `trade_level`  — ONE display-only rung key from the role's ladder. Never a
--                      match/rank input (see `packages/taxonomy/src/trade-levels.ts`).
--   * `trade_answers` — `{ "<question_key>": ["<option_key>", …] }` for the chips the
--                      poster selected. The API validates every key/option against the
--                      role's checked-in question pack and derives `match_skill_ids`
--                      from the match-affecting chips; this column is the poster's
--                      raw, reviewable answer set (facet + match chips alike).
--
-- BOTH ARE NULLABLE. NULL = "the poster stated none", which is every pre-0141 row and
-- every client that has not adopted the trade form yet. There is deliberately no
-- default: an empty object would claim the poster saw and skipped the questions.
--
-- APPLIED TO BOTH SERVED ENTITIES: `job_postings` (company postings) and `jobs`
-- (agency demand). Their V1 twin copies the fields, so an agency job and a company
-- posting state the same facts.
--
-- SHAPE CHECK ONLY, NO VALUE CHECK. The ladders and option keys are app-level data
-- (the trade-levels precedent) so promoting a rung or editing a pack never needs a
-- migration. The DB pins just the jsonb KIND, which is the property a writer can
-- break by accident.
--
-- ROLLBACK:
--   ALTER TABLE "job_postings" DROP CONSTRAINT IF EXISTS "job_postings_trade_answers_object_chk";
--   ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_trade_answers_object_chk";
--   ALTER TABLE "job_postings" DROP COLUMN IF EXISTS "trade_answers";
--   ALTER TABLE "job_postings" DROP COLUMN IF EXISTS "trade_level";
--   ALTER TABLE "jobs" DROP COLUMN IF EXISTS "trade_answers";
--   ALTER TABLE "jobs" DROP COLUMN IF EXISTS "trade_level";
ALTER TABLE "job_postings" ADD COLUMN "trade_level" text;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "trade_answers" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "trade_level" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "trade_answers" jsonb;--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_trade_answers_object_chk" CHECK ("job_postings"."trade_answers" IS NULL OR jsonb_typeof("job_postings"."trade_answers") = 'object');--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_trade_answers_object_chk" CHECK ("jobs"."trade_answers" IS NULL OR jsonb_typeof("jobs"."trade_answers") = 'object');