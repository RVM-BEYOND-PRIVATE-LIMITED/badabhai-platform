-- ==============================================================================
-- 0161 - the institute (Campus) student link and the worker's origin (#2752 part B)
-- ==============================================================================
--
-- Additive. Two new tables; no existing column, constraint or row is touched.
--   * worker_institute_links - one row per BadaBhai worker who is an institute's student (RVM
--     today). Keyed by worker, unique on (institute_code, student_ref). Holds only the agreed
--     plain facts (course, branch, current-student-or-alumnus as RVM sends it, test score), the
--     RVM consent version and time, and the link's own dates. Name and phone stay encrypted on
--     `workers`. Never fee, attendance, documents, date of birth or batch.
--   * worker_origins - where a worker came from, written once (first touch). A side table, not
--     columns on `workers`, so this migration is NOT apply-before-deploy for the sign-in path.
-- Both cascade on worker deletion (DPDP).
--
-- APPLY BEFORE THE CAMPUS LINK IS SWITCHED ON, not before deploy. Nothing reads or writes either
-- table while CAMPUS_LINK_ENABLED is off. Parts C and D of #2752 read `worker_institute_links`
-- from search and admin queries, and must ship either gated by the flag or after this is applied.
-- Registered in `schema-contract.ts` as `0161-worker-institute-links-rls` and
-- `0161-worker-origins-rls` only (the 0134 rule: flag-gated tables are not `table` entries).
--
-- LOCKS. CREATE TABLE touches nothing live. Each foreign key takes a brief SHARE ROW EXCLUSIVE
-- on `workers` (blocks worker writes for the moment it takes to validate an EMPTY table); the
-- short lock_timeout makes a busy moment a retry (55P03) rather than a stall of sign-in.
--
-- ROLLBACK, only after rolling the API back to a build that does not read either table:
--   BEGIN; SET LOCAL lock_timeout = '3s';
--   DROP TABLE "worker_origins";
--   DROP TABLE "worker_institute_links";
--   DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794573847887;
--   COMMIT;
-- Dropping `worker_institute_links` forgets which workers are institute students: their worker
-- rows remain, so they would read as ordinary workers. Unlink every student first if that matters.
-- ==============================================================================
SET lock_timeout='3s';--> statement-breakpoint
CREATE TABLE "worker_institute_links" (
	"worker_id" uuid PRIMARY KEY NOT NULL,
	"institute_code" text NOT NULL,
	"student_ref" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"student_status" text,
	"course" text,
	"branch" text,
	"test_score" numeric(5, 2),
	"consent_version" text,
	"consent_at" timestamp with time zone,
	"app_reachable" boolean DEFAULT false NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synced_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "worker_institute_links_institute_chk" CHECK ("worker_institute_links"."institute_code" IN ('rvm')),
	CONSTRAINT "worker_institute_links_status_chk" CHECK ("worker_institute_links"."status" IN ('active', 'withdrawn')),
	CONSTRAINT "worker_institute_links_withdrawn_pair_chk" CHECK (("worker_institute_links"."status" = 'withdrawn') = ("worker_institute_links"."withdrawn_at" IS NOT NULL)),
	CONSTRAINT "worker_institute_links_student_status_chk" CHECK ("worker_institute_links"."student_status" IS NULL OR "worker_institute_links"."student_status" IN ('current_student', 'alumnus')),
	CONSTRAINT "worker_institute_links_student_ref_chk" CHECK (char_length("worker_institute_links"."student_ref") BETWEEN 1 AND 128),
	CONSTRAINT "worker_institute_links_test_score_chk" CHECK ("worker_institute_links"."test_score" IS NULL OR ("worker_institute_links"."test_score" >= 0 AND "worker_institute_links"."test_score" <= 100))
);
--> statement-breakpoint
ALTER TABLE "worker_institute_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "worker_origins" (
	"worker_id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_origins_kind_chk" CHECK ("worker_origins"."kind" IN ('organic', 'institute', 'partner', 'referrer', 'agency', 'import')),
	CONSTRAINT "worker_origins_ref_chk" CHECK ("worker_origins"."ref" IS NULL OR char_length("worker_origins"."ref") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "worker_origins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_institute_links" ADD CONSTRAINT "worker_institute_links_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_origins" ADD CONSTRAINT "worker_origins_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "worker_institute_links_ref_uq" ON "worker_institute_links" USING btree ("institute_code","student_ref");--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLEs above; FORCE and the four REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 pattern), because a regenerate drops them silently.
-- ===========================================================================
ALTER TABLE "worker_institute_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_institute_links" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_institute_links" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_institute_links" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_institute_links" FROM service_role;--> statement-breakpoint
ALTER TABLE "worker_origins" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_origins" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_origins" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_origins" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_origins" FROM service_role;
