-- ==============================================================================
-- 0163 - search grants, Campus applications and Campus-created companies (#2752 items 10, 8, 5)
-- ==============================================================================
--
-- Additive. Three new tables; no existing column, constraint or row is touched.
--   * institute_search_grants - a company may find an institute student in ITS search, after
--     BadaBhai read his own yes from the institute by consent_ref. One live grant per company,
--     worker and institute; a revoke stamps revoked_at. Carries the one match skill (and its
--     industry) his course maps to, so no worker_skill row is ever written for a grant.
--   * institute_applications - an application that came from Campus: the Campus application id
--     (external_ref, unique per institute for good), the applications row the company sees, and
--     withdrawn_at. A SIDE TABLE so that applications gains no column (a bare select on it names
--     every model column, which would make a column APPLY-BEFORE-DEPLOY on the feed).
--   * institute_companies - a company the placement team created from Campus. Campus may publish
--     ONLY for these (owner decision 2026-11-14), and GET companies answers only these.
-- All cascade on worker or company deletion (DPDP); a Campus application also on posting
-- deletion, and its application_id goes null when the applications row is deleted.
-- Ids, codes and dates only: no name, phone, course text or free text.
--
-- APPLY ORDER: AFTER 0162, and BEFORE the build that reads these tables (#2752 part C3 / part E)
-- is deployed. Company search and the open gate read institute_search_grants unconditionally
-- (a grant outlives the flag), so this is APPLY-BEFORE-DEPLOY; registered in schema-contract.ts.
--
-- LOCKS. Each foreign key takes SHARE ROW EXCLUSIVE on its parent (workers, payers,
-- job_postings, applications) until COMMIT, so writes there wait for this short transaction
-- (empty tables, six indexes, the grants). The lock_timeout turns a busy moment into a retry
-- (55P03) rather than a stall.
--
-- ROLLBACK. Only with the API rolled back to a build that reads none of the tables, and only on
-- EMPTY tables; with rows it needs the owner's sign-off (it drops grants students consented to,
-- Campus's application ids, so a Campus retry would create a second application, and the record
-- of which companies Campus created).
--   BEGIN; SET LOCAL lock_timeout = '3s';
--   DO $$ BEGIN
--     IF EXISTS (SELECT 1 FROM "institute_search_grants")
--        OR EXISTS (SELECT 1 FROM "institute_applications")
--        OR EXISTS (SELECT 1 FROM "institute_companies")
--     THEN RAISE EXCEPTION '0163 rollback refused: the tables hold rows (owner sign-off needed)';
--     END IF;
--   END $$;
--   DROP TABLE "institute_applications";
--   DROP TABLE "institute_search_grants";
--   DROP TABLE "institute_companies";
--   DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794640564853;
--   COMMIT;
-- In the same code change, remove the three tables from LOCKED_TABLES in
-- tests/e2e/rls-spine.e2e.test.ts and the 0163 entries from schema-contract.ts.
-- ==============================================================================
SET lock_timeout='3s';--> statement-breakpoint
CREATE TABLE "institute_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institute_code" text NOT NULL,
	"external_ref" text NOT NULL,
	"application_id" uuid,
	"job_posting_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"campus_applied_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "institute_applications_institute_chk" CHECK ("institute_applications"."institute_code" IN ('rvm')),
	CONSTRAINT "institute_applications_ref_chk" CHECK ("institute_applications"."external_ref" ~ '^[A-Za-z0-9._:-]{8,200}$'),
	CONSTRAINT "institute_applications_withdrawn_chk" CHECK ("institute_applications"."withdrawn_at" IS NULL OR "institute_applications"."application_id" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "institute_applications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "institute_companies" (
	"payer_id" uuid PRIMARY KEY NOT NULL,
	"institute_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "institute_companies_institute_chk" CHECK ("institute_companies"."institute_code" IN ('rvm'))
);
--> statement-breakpoint
ALTER TABLE "institute_companies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "institute_search_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institute_code" text NOT NULL,
	"grant_ref" text NOT NULL,
	"payer_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"consent_ref" text NOT NULL,
	"skill_id" text,
	"industry_id" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "institute_search_grants_institute_chk" CHECK ("institute_search_grants"."institute_code" IN ('rvm')),
	CONSTRAINT "institute_search_grants_ref_chk" CHECK ("institute_search_grants"."grant_ref" ~ '^[A-Za-z0-9._:-]{8,200}$'),
	CONSTRAINT "institute_search_grants_consent_ref_chk" CHECK ("institute_search_grants"."consent_ref" ~ '^[A-Za-z0-9._:-]{8,200}$'),
	CONSTRAINT "institute_search_grants_skill_pair_chk" CHECK (("institute_search_grants"."skill_id" IS NULL) = ("institute_search_grants"."industry_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "institute_search_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "institute_applications" ADD CONSTRAINT "institute_applications_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institute_applications" ADD CONSTRAINT "institute_applications_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institute_applications" ADD CONSTRAINT "institute_applications_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institute_companies" ADD CONSTRAINT "institute_companies_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institute_search_grants" ADD CONSTRAINT "institute_search_grants_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institute_search_grants" ADD CONSTRAINT "institute_search_grants_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "institute_applications_ref_uq" ON "institute_applications" USING btree ("institute_code","external_ref");--> statement-breakpoint
CREATE INDEX "institute_applications_feed_idx" ON "institute_applications" USING btree ("institute_code","updated_at","id");--> statement-breakpoint
CREATE INDEX "institute_applications_worker_idx" ON "institute_applications" USING btree ("worker_id");--> statement-breakpoint
CREATE UNIQUE INDEX "institute_search_grants_ref_uq" ON "institute_search_grants" USING btree ("institute_code","grant_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "institute_search_grants_live_uq" ON "institute_search_grants" USING btree ("payer_id","worker_id","institute_code") WHERE "institute_search_grants"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "institute_search_grants_worker_idx" ON "institute_search_grants" USING btree ("worker_id");--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLEs above; FORCE and the four REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 / 0161 pattern), because a regenerate drops them silently.
-- ===========================================================================
ALTER TABLE "institute_search_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "institute_search_grants" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "institute_search_grants" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "institute_search_grants" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "institute_search_grants" FROM service_role;--> statement-breakpoint
ALTER TABLE "institute_applications" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "institute_applications" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "institute_applications" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "institute_applications" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "institute_applications" FROM service_role;--> statement-breakpoint
ALTER TABLE "institute_companies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "institute_companies" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "institute_companies" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "institute_companies" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "institute_companies" FROM service_role;
