-- ==============================================================================
-- rvm_applicant_waivers + rvm_waiver_uses: the placement team's waiver of the contact cost
-- (#2750 item 5)
-- ==============================================================================
--
-- (The header and the RLS tail below are HAND-WRITTEN and carry no migration number of their
-- own, so a regenerate under another slot keeps them word for word: re-prepend this header,
-- re-append the tail.)
--
-- #2750 item 5 (brief 4C.7, B2-37, B6-04, B6-05). Under the credit rules an RVM student who
-- applied costs one credit to open. RVM's placement team (from Campus, through the Campus service
-- route) or a BadaBhai super admin can waive that for ONE COMPANY (every RVM student who applied
-- to any of its jobs) or ONE JOB (the RVM students who applied to that job). Everyone else pays.
--
-- `rvm_applicant_waivers`: one row per waiver, never deleted. Clearing a waiver sets
-- `active = false` and the `cleared_*` columns on the same row, so the table keeps who waived
-- what, when and why. Two partial unique indexes keep at most ONE ACTIVE waiver per company and
-- per job. Staff names are stored ENCRYPTED (`*_label_enc`, owner ruling 2026-11-17).
--
-- `rvm_waiver_uses`: one row per waived open (unique `unlock_id`), written in the open's own
-- transaction beside its zero-credit `waived` ledger line. It answers "contacts opened under this
-- waiver"; the ledger line answers the numbers screen's "credits waived by the placement team".
--
-- ADDITIVE ONLY. Two new, EMPTY tables, their indexes and three foreign keys; no existing column,
-- constraint or row moves. Nothing is seeded. `credit_ledger.reason` is plain text with no CHECK,
-- so the new `waived` reason needs no DDL.
--
-- DEPLOY ORDER - APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY. Nothing names these tables while
-- CREDIT_RULES_ROLLOUT is off: the waiver routes answer 404 and no open reads a waiver. With the
-- switch on before this file, the waiver routes answer 503 and every open prices as if no waiver
-- existed (a 42P01 is read as "no waiver", logged once with its SQLSTATE), exactly as before this
-- change. Apply every lower-numbered migration first (slot order; the credit rules' own
-- `credit_rules_config` among them), then this, then set the switch.
--
-- LOCKS. The two new tables are empty. The foreign keys take a brief SHARE ROW EXCLUSIVE lock on
-- `job_postings` and `unlocks` (blocks their writes, not their reads, for the instant the
-- constraint is added; nothing to validate). Apply by hand in ONE
-- `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` and retry on a lock timeout.
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs per table at the end are HAND-WRITTEN (the
-- 0117 / 0156 / 0160 / 0161 / 0167 / 0175 / 0178 pattern) - a regenerate drops them silently.
-- Both tables are registered as `rls` entries in `schema-contract.ts` and listed in LOCKED_TABLES
-- in the e2e RLS spine.
--
-- ROLLBACK (switch CREDIT_RULES_ROLLOUT off and redeploy first; every waiver and its history is
-- lost, and the `waived` ledger lines stay as zero-credit lines with no waiver to name):
--   DROP TABLE "rvm_waiver_uses";
--   DROP TABLE "rvm_applicant_waivers";
-- and delete this migration's row from drizzle.__drizzle_migrations (the one whose created_at
-- is this entry's journal `when`).
--
-- SAFE TO RE-RUN: no (plain CREATE TABLE). Apply once.
-- ==============================================================================
CREATE TABLE "rvm_applicant_waivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"payer_id" uuid NOT NULL,
	"job_posting_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"source" text NOT NULL,
	"set_by_ref" text NOT NULL,
	"set_by_label_enc" text,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone,
	"cleared_by_ref" text,
	"cleared_by_label_enc" text,
	"clear_reason" text,
	CONSTRAINT "rvm_applicant_waivers_scope_chk" CHECK ("rvm_applicant_waivers"."scope" IN ('company', 'job')),
	CONSTRAINT "rvm_applicant_waivers_source_chk" CHECK ("rvm_applicant_waivers"."source" IN ('campus', 'admin')),
	CONSTRAINT "rvm_applicant_waivers_scope_posting_chk" CHECK (("rvm_applicant_waivers"."scope" = 'company' AND "rvm_applicant_waivers"."job_posting_id" IS NULL) OR ("rvm_applicant_waivers"."scope" = 'job' AND "rvm_applicant_waivers"."job_posting_id" IS NOT NULL)),
	CONSTRAINT "rvm_applicant_waivers_active_chk" CHECK ("rvm_applicant_waivers"."active" = ("rvm_applicant_waivers"."cleared_at" IS NULL) AND ("rvm_applicant_waivers"."cleared_at" IS NULL OR "rvm_applicant_waivers"."cleared_by_ref" IS NOT NULL)),
	CONSTRAINT "rvm_applicant_waivers_text_chk" CHECK (char_length("rvm_applicant_waivers"."set_by_ref") BETWEEN 1 AND 128 AND char_length("rvm_applicant_waivers"."reason") BETWEEN 1 AND 500 AND ("rvm_applicant_waivers"."cleared_by_ref" IS NULL OR char_length("rvm_applicant_waivers"."cleared_by_ref") BETWEEN 1 AND 128) AND ("rvm_applicant_waivers"."clear_reason" IS NULL OR char_length("rvm_applicant_waivers"."clear_reason") <= 500))
);
--> statement-breakpoint
ALTER TABLE "rvm_applicant_waivers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "rvm_waiver_uses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"waiver_id" uuid NOT NULL,
	"unlock_id" uuid NOT NULL,
	"payer_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rvm_waiver_uses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rvm_applicant_waivers" ADD CONSTRAINT "rvm_applicant_waivers_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rvm_waiver_uses" ADD CONSTRAINT "rvm_waiver_uses_waiver_id_rvm_applicant_waivers_id_fk" FOREIGN KEY ("waiver_id") REFERENCES "public"."rvm_applicant_waivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rvm_waiver_uses" ADD CONSTRAINT "rvm_waiver_uses_unlock_id_unlocks_id_fk" FOREIGN KEY ("unlock_id") REFERENCES "public"."unlocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rvm_applicant_waivers_company_active_uq" ON "rvm_applicant_waivers" USING btree ("payer_id") WHERE "rvm_applicant_waivers"."active" AND "rvm_applicant_waivers"."scope" = 'company';--> statement-breakpoint
CREATE UNIQUE INDEX "rvm_applicant_waivers_job_active_uq" ON "rvm_applicant_waivers" USING btree ("job_posting_id") WHERE "rvm_applicant_waivers"."active" AND "rvm_applicant_waivers"."scope" = 'job';--> statement-breakpoint
CREATE INDEX "rvm_applicant_waivers_payer_idx" ON "rvm_applicant_waivers" USING btree ("payer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "rvm_applicant_waivers_job_posting_idx" ON "rvm_applicant_waivers" USING btree ("job_posting_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rvm_waiver_uses_unlock_uq" ON "rvm_waiver_uses" USING btree ("unlock_id");--> statement-breakpoint
CREATE INDEX "rvm_waiver_uses_waiver_idx" ON "rvm_waiver_uses" USING btree ("waiver_id");
--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY, on both tables.
-- `drizzle-kit generate` emits only the ENABLEs above; FORCE and the REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 / 0161 / 0167 / 0178 pattern), because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "rvm_applicant_waivers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "rvm_applicant_waivers" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "rvm_applicant_waivers" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "rvm_applicant_waivers" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "rvm_applicant_waivers" FROM service_role;--> statement-breakpoint
ALTER TABLE "rvm_waiver_uses" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "rvm_waiver_uses" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "rvm_waiver_uses" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "rvm_waiver_uses" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "rvm_waiver_uses" FROM service_role;
