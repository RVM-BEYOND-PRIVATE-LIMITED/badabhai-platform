-- ==============================================================================
-- 0162 - job audience, RVM review state, targeting options, campus-drive requests, pilot list (#2746)
-- ==============================================================================
--
-- SLOT. 0161 is #2752 Part B's `0161_institute_link` (PR #2795); this file chains from its
-- snapshot and merges after it. Re-check `meta/_journal.json` on origin/main before applying.
--
-- Additive. No column is altered or dropped and no existing row is rewritten.
--   * job_postings.audience text NOT NULL DEFAULT 'badabhai_workers' + rvm_branch_ids /
--       rvm_course_ids jsonb NOT NULL DEFAULT '[]'. Every existing posting becomes a
--       BadaBhai-worker job with no RVM targeting, which is exactly what it was.
--       job_postings_audience_chk closes the set; job_postings_twin_audience_chk keeps every
--       agency twin on 'badabhai_workers'; job_postings_rvm_targeting_chk pins the list shapes
--       (positive integer branch ids <= 50, 1-64 char course ids <= 100) and allows targeting on
--       an RVM audience only.
--   * payers.is_test_account boolean NOT NULL DEFAULT false - the company test marker.
--   * job_posting_institute_reviews - the placement team's review of the RVM part of a posting
--       (one row per posting and institute; THE one review store, owner ruling 2026-11-13 - no
--       rvm_review_* columns). Never deleted when the audience is withdrawn: Campus's feed is
--       driven from these rows (jpir_feed_idx). Narrowed lists are non-empty when set; staff
--       refs are uuids. Cascades with the posting.
--   * rvm_targeting_options - branch and course labels a company may target (reference data).
--   * campus_drive_requests - a company's request for a campus drive. contact_name_enc /
--       contact_phone_enc are AES ciphertext behind a token-shape CHECK, registered for key
--       rotation in packages/db/src/reencrypt-pii-backfill.ts in this same change, and ERASABLE
--       (both NULL + contact_erased_at, cdr_contact_chk) for a DPDP request by a contact who has
--       no BadaBhai account. roles_note is company free text: the payer DTO screens it for
--       contact details (#2746 PR 6), the database cannot.
--   * feature_pilot_payers - the pilot list behind each off/pilot/on switch (#2747-#2750 reuse
--       it); every row records added_by and reason, because #2749 gates real payments on it.
--   Each new table: RLS ENABLE + hand-appended FORCE + four REVOKEs, no policy.
--
-- PREFLIGHT: none needed. The new CHECKs validate existing job_postings rows, and every
-- existing row carries the defaults ('badabhai_workers', '[]', '[]'), which satisfy all three.
--
-- APPLY-BEFORE-MERGE (stronger than apply-before-deploy). The `production` environment has no
-- protection rule, so `deploy-lightsail` ships main on every push with no approval step.
-- JobPostingsRepository, AgencyJobsRepository and ApplicationsRepository.findJobById name every
-- job_postings model column through bare `select()` / `.returning()`, and PayersRepository does
-- the same for payers on every payer auth request: the new build on an unmigrated database 500s
-- every posting route, the legacy apply path and every company sign-in. The OLD build on a
-- migrated database is fine (a superset). Order:
--   1. 0161 (#2795) is merged, applied and adopted first.
--   2. LEDGER PRE-CHECK: `npx tsx adopt-migrations.ts` verify-only, no --only. Adopting 0162 moves
--      the watermark past every lower unrecorded entry, which `db:migrate` then skips forever;
--      confirm everything up to 0161 is live first.
--   3. Apply this file by hand in one transaction; probe each object.
--   4. Adopt the ledger row from THIS branch's tree (main has no 0162 entry yet), the file
--      byte-identical to the PR head: `npx tsx adopt-migrations.ts --only
--      0162_job_audience_campus_drives --apply --expect-host <HOST>` (--apply refuses without
--      --expect-host). From then on the file is frozen; a change is a new migration.
--   5. `pnpm db:audit:schema-contract`, then merge AT ONCE (an abandoned PR leaves a ledger row
--      that matches no file on main).
-- Registered as the seven 0162-* entries in schema-contract.ts (two columns, the twin CHECK and
-- four table locks). The four new tables are named only behind the #2746 switches.
--
-- LOCKS. The ADD COLUMNs are catalog-only (PG11+ fast default) but each takes a brief ACCESS
-- EXCLUSIVE, on job_postings (every feed read) and then on payers (every payer request), hence
-- the short lock_timeout. While it waits for payers, job_postings readers wait too (at most 3s).
-- An app transaction taking the two in the other order can deadlock it: retry on 55P03 AND
-- 40P01, nothing is applied in either case. The three CHECKs scan job_postings (~211 rows on
-- 2026-11-09) under that lock. The CREATE TABLEs and their indexes touch nothing live.
--
-- ROLLBACK, only AFTER rolling the API back to a build that does not name these columns and
-- tables. FIRST hide every RVM-only posting through the admin hide action (it emits the events),
-- because any API older than the audience filter shows an 'rvm_students' posting to BadaBhai
-- workers whether or not the column still exists; old builds already respect hidden_at:
--   SELECT id FROM job_postings WHERE audience = 'rvm_students' AND hidden_at IS NULL;
-- Then:
--   BEGIN; SET LOCAL lock_timeout = '3s';
--   DROP TABLE IF EXISTS "feature_pilot_payers";
--   DROP TABLE IF EXISTS "campus_drive_requests";
--   DROP TABLE IF EXISTS "rvm_targeting_options";
--   DROP TABLE IF EXISTS "job_posting_institute_reviews";
--   ALTER TABLE "job_postings" DROP CONSTRAINT IF EXISTS "job_postings_rvm_targeting_chk",
--     DROP CONSTRAINT IF EXISTS "job_postings_twin_audience_chk",
--     DROP CONSTRAINT IF EXISTS "job_postings_audience_chk";
--   ALTER TABLE "job_postings" DROP COLUMN IF EXISTS "rvm_course_ids",
--     DROP COLUMN IF EXISTS "rvm_branch_ids", DROP COLUMN IF EXISTS "audience";
--   ALTER TABLE "payers" DROP COLUMN IF EXISTS "is_test_account";
--   DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794575613179;
--   COMMIT;
-- Dropping the tables loses every review decision, drive request and pilot entry; the
-- job_posting.* and campus_drive.* events (ids only) survive.
-- ==============================================================================
SET lock_timeout='3s';--> statement-breakpoint
CREATE TABLE "job_posting_institute_reviews" (
	"job_posting_id" uuid NOT NULL,
	"institute_code" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"reviewer_ref" text,
	"reviewed_at" timestamp with time zone,
	"reason" text,
	"branch_ids" jsonb,
	"course_ids" jsonb,
	"content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_posting_institute_reviews_pk" PRIMARY KEY("job_posting_id","institute_code"),
	CONSTRAINT "jpir_institute_code_chk" CHECK ("job_posting_institute_reviews"."institute_code" IN ('rvm')),
	CONSTRAINT "jpir_state_chk" CHECK ("job_posting_institute_reviews"."state" IN ('pending', 'approved', 'rejected')),
	CONSTRAINT "jpir_decision_chk" CHECK (("job_posting_institute_reviews"."state" = 'pending' AND "job_posting_institute_reviews"."reviewer_ref" IS NULL AND "job_posting_institute_reviews"."reviewed_at" IS NULL
          AND "job_posting_institute_reviews"."reason" IS NULL AND "job_posting_institute_reviews"."branch_ids" IS NULL AND "job_posting_institute_reviews"."course_ids" IS NULL
          AND "job_posting_institute_reviews"."content_hash" IS NULL)
        OR ("job_posting_institute_reviews"."state" IN ('approved', 'rejected') AND "job_posting_institute_reviews"."reviewer_ref" IS NOT NULL
          AND "job_posting_institute_reviews"."reviewed_at" IS NOT NULL AND "job_posting_institute_reviews"."content_hash" IS NOT NULL)),
	CONSTRAINT "jpir_reviewer_ref_chk" CHECK ("job_posting_institute_reviews"."reviewer_ref" IS NULL OR "job_posting_institute_reviews"."reviewer_ref" ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'),
	CONSTRAINT "jpir_reason_chk" CHECK ("job_posting_institute_reviews"."reason" IS NULL OR char_length("job_posting_institute_reviews"."reason") BETWEEN 1 AND 500),
	CONSTRAINT "jpir_narrowing_chk" CHECK (("job_posting_institute_reviews"."branch_ids" IS NULL OR (jsonb_typeof("job_posting_institute_reviews"."branch_ids") = 'array'
          AND jsonb_array_length("job_posting_institute_reviews"."branch_ids") BETWEEN 1 AND 50
          AND NOT jsonb_path_exists("job_posting_institute_reviews"."branch_ids", '$[*] ? (@.type() != "number" || @ < 1 || @.floor() != @)')))
        AND ("job_posting_institute_reviews"."course_ids" IS NULL OR (jsonb_typeof("job_posting_institute_reviews"."course_ids") = 'array'
          AND jsonb_array_length("job_posting_institute_reviews"."course_ids") BETWEEN 1 AND 100
          AND NOT jsonb_path_exists("job_posting_institute_reviews"."course_ids", '$[*] ? (@.type() != "string" || !(@ like_regex "^.{1,64}$"))')))),
	CONSTRAINT "jpir_content_hash_chk" CHECK ("job_posting_institute_reviews"."content_hash" IS NULL OR "job_posting_institute_reviews"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "job_posting_institute_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "rvm_targeting_options" (
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"label" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rvm_targeting_options_pk" PRIMARY KEY("kind","ref"),
	CONSTRAINT "rto_kind_chk" CHECK ("rvm_targeting_options"."kind" IN ('branch', 'course')),
	CONSTRAINT "rto_ref_chk" CHECK (char_length("rvm_targeting_options"."ref") BETWEEN 1 AND 64),
	CONSTRAINT "rto_branch_ref_chk" CHECK ("rvm_targeting_options"."kind" <> 'branch' OR "rvm_targeting_options"."ref" ~ '^[1-9][0-9]{0,9}$'),
	CONSTRAINT "rto_label_chk" CHECK (char_length("rvm_targeting_options"."label") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "rvm_targeting_options" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "campus_drive_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payer_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"job_posting_id" uuid,
	"branch_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preferred_from" date NOT NULL,
	"preferred_to" date NOT NULL,
	"openings" integer NOT NULL,
	"roles_note" text,
	"contact_name_enc" text,
	"contact_phone_enc" text,
	"contact_erased_at" timestamp with time zone,
	"status" text DEFAULT 'requested' NOT NULL,
	"scheduled_on" date,
	"campus_drive_ref" text,
	"decided_at" timestamp with time zone,
	"decided_by_ref" text,
	"decision_reason" text,
	"cancelled_at" timestamp with time zone,
	"is_test" boolean DEFAULT false NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cdr_status_chk" CHECK ("campus_drive_requests"."status" IN ('requested', 'scheduled', 'declined', 'completed', 'cancelled')),
	CONSTRAINT "cdr_window_chk" CHECK ("campus_drive_requests"."preferred_to" >= "campus_drive_requests"."preferred_from"),
	CONSTRAINT "cdr_openings_chk" CHECK ("campus_drive_requests"."openings" BETWEEN 1 AND 1000),
	CONSTRAINT "cdr_branch_ids_chk" CHECK (jsonb_typeof("campus_drive_requests"."branch_ids") = 'array' AND jsonb_array_length("campus_drive_requests"."branch_ids") <= 50
        AND NOT jsonb_path_exists("campus_drive_requests"."branch_ids", '$[*] ? (@.type() != "number" || @ < 1 || @.floor() != @)')),
	CONSTRAINT "cdr_roles_note_chk" CHECK ("campus_drive_requests"."roles_note" IS NULL OR char_length("campus_drive_requests"."roles_note") BETWEEN 1 AND 1000),
	CONSTRAINT "cdr_scheduled_on_chk" CHECK ("campus_drive_requests"."status" NOT IN ('scheduled', 'completed') OR "campus_drive_requests"."scheduled_on" IS NOT NULL),
	CONSTRAINT "cdr_decision_chk" CHECK ("campus_drive_requests"."status" IN ('requested', 'cancelled')
        OR ("campus_drive_requests"."decided_at" IS NOT NULL AND "campus_drive_requests"."decided_by_ref" IS NOT NULL)),
	CONSTRAINT "cdr_cancelled_chk" CHECK ("campus_drive_requests"."status" <> 'cancelled' OR "campus_drive_requests"."cancelled_at" IS NOT NULL),
	CONSTRAINT "cdr_refs_chk" CHECK (("campus_drive_requests"."decided_by_ref" IS NULL OR "campus_drive_requests"."decided_by_ref" ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
        AND ("campus_drive_requests"."campus_drive_ref" IS NULL OR "campus_drive_requests"."campus_drive_ref" ~ '^[A-Za-z0-9._:-]{1,200}$')),
	CONSTRAINT "cdr_decision_reason_chk" CHECK ("campus_drive_requests"."decision_reason" IS NULL OR char_length("campus_drive_requests"."decision_reason") BETWEEN 1 AND 500),
	CONSTRAINT "cdr_idempotency_key_chk" CHECK ("campus_drive_requests"."idempotency_key" ~ '^[A-Za-z0-9._:-]{8,200}$'),
	CONSTRAINT "cdr_contact_chk" CHECK (("campus_drive_requests"."contact_erased_at" IS NULL AND "campus_drive_requests"."contact_name_enc" IS NOT NULL AND "campus_drive_requests"."contact_phone_enc" IS NOT NULL)
        OR ("campus_drive_requests"."contact_erased_at" IS NOT NULL AND "campus_drive_requests"."contact_name_enc" IS NULL AND "campus_drive_requests"."contact_phone_enc" IS NULL)),
	CONSTRAINT "cdr_contact_name_enc_chk" CHECK ("campus_drive_requests"."contact_name_enc" IS NULL OR "campus_drive_requests"."contact_name_enc" ~ '^(v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+|v2\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+)$'),
	CONSTRAINT "cdr_contact_phone_enc_chk" CHECK ("campus_drive_requests"."contact_phone_enc" IS NULL OR "campus_drive_requests"."contact_phone_enc" ~ '^(v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+|v2\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+)$')
);
--> statement-breakpoint
ALTER TABLE "campus_drive_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "feature_pilot_payers" (
	"feature" text NOT NULL,
	"payer_id" uuid NOT NULL,
	"added_by" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_pilot_payers_pk" PRIMARY KEY("feature","payer_id"),
	CONSTRAINT "fpp_feature_chk" CHECK ("feature_pilot_payers"."feature" ~ '^[a-z][a-z0-9_]{1,63}$'),
	CONSTRAINT "fpp_added_by_chk" CHECK ("feature_pilot_payers"."added_by" ~ '^[A-Za-z0-9._:-]{1,128}$'),
	CONSTRAINT "fpp_reason_chk" CHECK (char_length("feature_pilot_payers"."reason") BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "feature_pilot_payers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "audience" text DEFAULT 'badabhai_workers' NOT NULL;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "rvm_branch_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "rvm_course_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "payers" ADD COLUMN "is_test_account" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "job_posting_institute_reviews" ADD CONSTRAINT "job_posting_institute_reviews_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus_drive_requests" ADD CONSTRAINT "campus_drive_requests_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campus_drive_requests" ADD CONSTRAINT "campus_drive_requests_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_pilot_payers" ADD CONSTRAINT "feature_pilot_payers_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jpir_feed_idx" ON "job_posting_institute_reviews" USING btree ("institute_code","updated_at","job_posting_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campus_drive_requests_idempotency_uq" ON "campus_drive_requests" USING btree ("payer_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "campus_drive_requests_payer_idx" ON "campus_drive_requests" USING btree ("payer_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "campus_drive_requests_changed_idx" ON "campus_drive_requests" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "campus_drive_requests_job_posting_idx" ON "campus_drive_requests" USING btree ("job_posting_id");--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_audience_chk" CHECK ("job_postings"."audience" IN ('badabhai_workers', 'rvm_students', 'both'));--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_twin_audience_chk" CHECK ("job_postings"."sync_source" IS NULL OR "job_postings"."audience" = 'badabhai_workers');--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_rvm_targeting_chk" CHECK (jsonb_typeof("job_postings"."rvm_branch_ids") = 'array' AND jsonb_array_length("job_postings"."rvm_branch_ids") <= 50
        AND NOT jsonb_path_exists("job_postings"."rvm_branch_ids", '$[*] ? (@.type() != "number" || @ < 1 || @.floor() != @)')
        AND jsonb_typeof("job_postings"."rvm_course_ids") = 'array' AND jsonb_array_length("job_postings"."rvm_course_ids") <= 100
        AND NOT jsonb_path_exists("job_postings"."rvm_course_ids", '$[*] ? (@.type() != "string" || !(@ like_regex "^.{1,64}$"))')
        AND ("job_postings"."audience" <> 'badabhai_workers' OR ("job_postings"."rvm_branch_ids" = '[]'::jsonb AND "job_postings"."rvm_course_ids" = '[]'::jsonb)));--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLEs above; FORCE and the four REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 pattern), because a regenerate drops them silently.
-- ===========================================================================
ALTER TABLE "job_posting_institute_reviews" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "job_posting_institute_reviews" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "job_posting_institute_reviews" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "job_posting_institute_reviews" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "job_posting_institute_reviews" FROM service_role;--> statement-breakpoint
ALTER TABLE "rvm_targeting_options" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "rvm_targeting_options" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "rvm_targeting_options" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "rvm_targeting_options" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "rvm_targeting_options" FROM service_role;--> statement-breakpoint
ALTER TABLE "campus_drive_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "campus_drive_requests" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "campus_drive_requests" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "campus_drive_requests" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "campus_drive_requests" FROM service_role;--> statement-breakpoint
ALTER TABLE "feature_pilot_payers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "feature_pilot_payers" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "feature_pilot_payers" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "feature_pilot_payers" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "feature_pilot_payers" FROM service_role;