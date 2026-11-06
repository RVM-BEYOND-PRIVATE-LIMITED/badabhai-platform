-- ==============================================================================
-- 0160 - admin corrections: the ADR-0062 correction layer + the 'admin_edit' résumé trigger (#2561 B7)
-- ==============================================================================
--
-- Additive. One new table and one CHECK widening; no existing column or row is rewritten.
--   * worker_admin_override (ADR-0062 §3.1) - one row per ADMIN correction of one editable
--     fact. `value_enc` is the `{corrected, previous}` envelope, AES-256-GCM; `previous` is
--     the last non-admin effective value, which is what makes REVERT honest. A partial unique
--     index holds "at most one LIVE correction per (worker, fact)"; a re-correction supersedes
--     the live row and inserts its replacement in the same transaction. `superseded_by_id`
--     NULL with `superseded_at` set means a revert or a worker self-edit (owner ruling A1).
--     `worker_id` cascades on worker deletion (DPDP), and `value_enc` is registered as a PII
--     rotation target in `packages/db/src/reencrypt-pii-backfill.ts` in this same change.
--   * generated_resumes_generation_trigger_chk - ADR-0062 §3.3 adds the `admin_edit` trigger:
--     an admin correction of a SNAPSHOT field (skills, trade/role, total experience) creates a
--     new résumé version instead of redrawing the latest. Every old value and NULL stays valid;
--     the constraint is dropped and re-added with one extra member.
--
-- APPLY-BEFORE-DEPLOY. The correction resolver reads `worker_admin_override` on the candidate
-- read path, and `ResumeService.generate` can now write `admin_edit`; the new build on an
-- unmigrated database 500s those paths. The OLD build on a migrated database is fine (a
-- superset). Registered in `schema-contract.ts` as `0160-worker-admin-override`.
--
-- LOCKS. CREATE TABLE touches nothing live. The CHECK widening on `generated_resumes` takes a
-- brief ACCESS EXCLUSIVE and scans that table (resume history - small); the short lock_timeout
-- makes a busy moment a retry (55P03) rather than a stall of the résumé path.
--
-- ROLLBACK, only AFTER rolling the API back to a build that does not read the table, and after
-- deleting every correction (the table is the only store of the corrected/previous values):
--   BEGIN; SET LOCAL lock_timeout = '3s';
--   ALTER TABLE "generated_resumes" DROP CONSTRAINT "generated_resumes_generation_trigger_chk";
--   ALTER TABLE "generated_resumes" ADD CONSTRAINT "generated_resumes_generation_trigger_chk"
--     CHECK ("generated_resumes"."generation_trigger" IS NULL OR "generated_resumes"."generation_trigger"
--       IN ('profile_confirmed', 'manual', 'chat_update_accepted', 'ops_regenerate', 'chat_edit'));
--   DROP TABLE "worker_admin_override";
--   DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1793960146492;
--   COMMIT;
-- Dropping the table loses every correction and the `previous` values a revert needs; the
-- `admin.candidate_field_corrected` / `_reverted` events (ids + fact keys only) survive.
-- ==============================================================================
SET lock_timeout='3s';--> statement-breakpoint
CREATE TABLE "worker_admin_override" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"fact_key" text NOT NULL,
	"value_enc" text NOT NULL,
	"admin_id" uuid NOT NULL,
	"reason_code" text NOT NULL,
	"reason_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"superseded_by_id" uuid,
	CONSTRAINT "worker_admin_override_fact_key_chk" CHECK ("worker_admin_override"."fact_key" IN ('current_city', 'preferred_locations', 'trade', 'role', 'secondary_roles', 'skills', 'experience', 'work_history', 'education', 'certifications', 'training', 'languages', 'salary_expected', 'salary_period', 'availability', 'shift', 'relocation', 'accommodation', 'job_type', 'work_types', 'commute_max_km', 'willing_to_travel', 'documents_ready')),
	CONSTRAINT "worker_admin_override_reason_chk" CHECK (char_length("worker_admin_override"."reason_text") BETWEEN 15 AND 500),
	CONSTRAINT "worker_admin_override_superseded_pair_chk" CHECK (("worker_admin_override"."superseded_at" IS NULL AND "worker_admin_override"."superseded_by_id" IS NULL) OR "worker_admin_override"."superseded_at" IS NOT NULL),
	CONSTRAINT "worker_admin_override_value_enc_chk" CHECK ("worker_admin_override"."value_enc" ~ '^(v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+|v2\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+)$')
);
--> statement-breakpoint
ALTER TABLE "worker_admin_override" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "generated_resumes" DROP CONSTRAINT "generated_resumes_generation_trigger_chk";--> statement-breakpoint
ALTER TABLE "worker_admin_override" ADD CONSTRAINT "worker_admin_override_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_admin_override" ADD CONSTRAINT "worker_admin_override_superseded_by_id_worker_admin_override_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."worker_admin_override"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "worker_admin_override_live_uq" ON "worker_admin_override" USING btree ("worker_id","fact_key") WHERE superseded_at IS NULL;--> statement-breakpoint
CREATE INDEX "worker_admin_override_worker_idx" ON "worker_admin_override" USING btree ("worker_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "generated_resumes" ADD CONSTRAINT "generated_resumes_generation_trigger_chk" CHECK ("generated_resumes"."generation_trigger" IS NULL OR "generated_resumes"."generation_trigger" IN ('profile_confirmed', 'manual', 'chat_update_accepted', 'ops_regenerate', 'chat_edit', 'admin_edit'));--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLE above; FORCE and the four REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 pattern), because a regenerate drops them silently.
-- ===========================================================================
ALTER TABLE "worker_admin_override" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_admin_override" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_admin_override" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_admin_override" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_admin_override" FROM service_role;
