-- ===========================================================================
-- 0107 — worker_profiles gains `source`: the road that produced the profile
--
-- Task 1 flow separation. Every profile is now tagged `form` (trade-form road:
-- a form-enabled trade, entered via the chat handover or a résumé routed to a
-- form) or `chat` (the LLM-chat road: everything else). Navigation, profile
-- screens and the resume renderer key off this instead of probing "does a form
-- exist", which is what mixed the two roads.
--
-- Written ONCE, deterministically, by the extraction processor from the channel
-- record — never by the model, never re-derived on read. The CHECK keeps the
-- vocabulary closed; NULL stays legal for rows written before this migration
-- ("written before the road was recorded"), and readers must treat NULL as
-- unknown, never as a road.
--
-- BACKFILL (same rule the writer uses, applied to history): `form` where any
-- form evidence exists for the worker — a chat session carrying `form_kind`
-- (the handover is its sole writer) or a résumé import routed to a form —
-- else `chat`. Form answers cannot exist without one of those two (the form
-- 404s otherwise), so no third signal is needed.
--
-- ADDITIVE, BACKWARD-COMPATIBLE. No column removed, no existing row's meaning
-- changed. Old code reading `worker_profiles` ignores the new column; new code
-- treats NULL as unknown.
--
-- APPLY-BEFORE-DEPLOY. Once code that WRITES `source` ships, this migration
-- must already be applied — an INSERT naming a column that does not exist yet
-- fails closed (500), never partially.
--
-- ROLLBACK: additive-only, straight reversal while no writer has shipped:
--   ALTER TABLE "worker_profiles" DROP CONSTRAINT "worker_profiles_source_chk";
--   ALTER TABLE "worker_profiles" DROP COLUMN "source";
-- Once the extraction writer ships, rollback is code-only (stop writing the
-- column); dropping it would destroy the road record for real profiles.
-- ===========================================================================
ALTER TABLE "worker_profiles" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_source_chk" CHECK ("worker_profiles"."source" IS NULL OR "worker_profiles"."source" IN ('form', 'chat'));--> statement-breakpoint
UPDATE "worker_profiles" p SET "source" = 'form' WHERE EXISTS (
  SELECT 1 FROM "chat_sessions" s
  WHERE s."worker_id" = p."worker_id"
    AND (s."conversation_state" ->> 'form_kind') IS NOT NULL
) OR EXISTS (
  SELECT 1 FROM "worker_resume_import" i
  WHERE i."worker_id" = p."worker_id"
    AND i."route" = 'form'
);--> statement-breakpoint
UPDATE "worker_profiles" p SET "source" = 'chat' WHERE p."source" IS NULL;
