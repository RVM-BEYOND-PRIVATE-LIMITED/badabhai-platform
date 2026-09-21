-- ===========================================================================
-- 0118 — worker_resume_import gains the RI-identity staging columns: the
-- Hinglish line ("is this you?") the chat turn renders.
--
-- RI-identity. `identity_role_kind` (one of the 9 ENABLED form kinds, or NULL),
-- `identity_experience_text` and `identity_summary_text` (short Hinglish strings,
-- PII-certified by both walls before they are written). RECORDED, NOT ACTED ON:
-- the worker's tap answers whether the line is his; nothing here routes, stages
-- an answer, or reaches the sheet.
--
-- PLAIN TEXT, NOT ENCRYPTED. `suggestions_enc` is sealed because it carries
-- employer names lifted from the document; these three carry a closed-set kind
-- id and two certified Hinglish strings — nothing PiiCrypto must cover.
--
-- NO BACKFILL. NULL honestly means "summarized before the call existed",
-- exactly like the sibling nullable columns.
--
-- ADDITIVE, BACKWARD-COMPATIBLE. No column removed, no existing row touched.
-- Old code ignores the columns; new code treats NULL as unknown.
--
-- APPLY-BEFORE-DEPLOY. Once the summary stager ships, this migration must
-- already be applied — the guarded UPDATE naming a missing column fails closed
-- (500), never partially.
--
-- ROLLBACK: additive-only, straight reversal while the stager is undeployed:
--   ALTER TABLE "worker_resume_import" DROP CONSTRAINT "wri_identity_role_kind_chk";
--   ALTER TABLE "worker_resume_import" DROP COLUMN "identity_role_kind";
--   ALTER TABLE "worker_resume_import" DROP COLUMN "identity_experience_text";
--   ALTER TABLE "worker_resume_import" DROP COLUMN "identity_summary_text";
-- Once staged rows carry summaries, rollback is code-only (stop writing the
-- columns), never a schema rollback.
--
-- NOTE: hand-trimmed after `db:generate`, which also emitted the 0117
-- `profile_correction` table (already migrated). Only the
-- `worker_resume_import` statements below belong to 0118.
-- ===========================================================================
ALTER TABLE "worker_resume_import" ADD COLUMN "identity_role_kind" text;--> statement-breakpoint
ALTER TABLE "worker_resume_import" ADD COLUMN "identity_experience_text" text;--> statement-breakpoint
ALTER TABLE "worker_resume_import" ADD COLUMN "identity_summary_text" text;--> statement-breakpoint
ALTER TABLE "worker_resume_import" ADD CONSTRAINT "wri_identity_role_kind_chk" CHECK ("worker_resume_import"."identity_role_kind" IS NULL OR "worker_resume_import"."identity_role_kind" IN ('cnc_turner', 'vmc_milling', 'cnc_grinding', 'conventional_machinist', 'tool_die_maker', 'cam_programmer', 'cad_draughtsman', 'welder', 'painter_coating'));
