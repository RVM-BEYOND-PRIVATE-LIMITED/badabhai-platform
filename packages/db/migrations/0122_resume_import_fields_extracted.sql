-- ===========================================================================
-- 0122 - worker_resume_import.fields_extracted (#1660)
--
-- PURELY ADDITIVE. One nullable integer, one NULL-tolerant CHECK, no backfill.
--
-- The count `profile.resume_parsed` has always carried, now on the ROW as well, because
-- an event is not a read. The import status endpoint could answer
-- `status: "parsed", route: "chat", failure_reason: null` - a clean success by every
-- field on the wire - for an import that extracted nothing at all, so the worker-app had
-- no way to tell a productive chat-routed import from an empty one. He waited through the
-- poll, landed in the ordinary interview, and was told nothing.
--
-- NULL IS NOT ZERO. NULL means "parsed before this column existed"; the derived
-- `yielded_nothing` on the read answers false for it, because "we did not record it" must
-- never render to a worker as "we found nothing".
--
-- ROLLBACK: drop the CHECK and the column. Nothing reads it fail-closed.
-- ===========================================================================
ALTER TABLE "worker_resume_import" ADD COLUMN "fields_extracted" integer;--> statement-breakpoint
ALTER TABLE "worker_resume_import" ADD CONSTRAINT "wri_fields_extracted_nonneg_chk" CHECK ("worker_resume_import"."fields_extracted" IS NULL OR "worker_resume_import"."fields_extracted" >= 0);