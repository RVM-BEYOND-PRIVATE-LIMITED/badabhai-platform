-- ==============================================================================
-- admin_job_audience: an admin decides where each job shows (#2956), and the trades RVM trains (#2957)
-- ==============================================================================
--
-- (The header and the RLS tail below are HAND-WRITTEN and carry no migration number of their
-- own, so a regenerate under another slot keeps them word for word: re-prepend this header,
-- re-append the tail.)
--
-- Owner direction of 19 Nov 2026 (#2959): every company comes in through BadaBhai, and a BadaBhai
-- ADMIN, not the company, decides where each job shows: Campus only (`rvm_students`), both, or
-- BadaBhai only (`badabhai_workers`). Only a trade RVM trains may go to Campus.
--   - `job_posting_audience_decisions`: the latest admin decision per posting (audience, the
--     posting's review content hash at decision time, who and when). No row = not decided yet.
--     `job_postings.audience` stays the value every reader obeys; this row only records the
--     decision, so the admin list can show "to decide" and "changed since decision".
--   - `campus_trades`: the trade keys (`role_kind` values) RVM trains. A removal is stamped,
--     never deleted.
--
-- ADDITIVE ONLY. Two new, EMPTY tables and one foreign key; no existing column, constraint or row
-- moves. Nothing is seeded or backfilled: the trade list is entered by an admin through the API.
--
-- DEPLOY ORDER - APPLY BEFORE `ADMIN_JOB_AUDIENCE_ENABLED` IS TURNED ON, NOT BEFORE THE DEPLOY.
-- Only the admin audience routes read or write these tables, and they answer 404 while the switch
-- is off (the default). No worker read, Campus route or company route names either table. So the
-- code may deploy before the apply; turn the switch on only after it.
--
-- LOCKS. Both tables are new and empty. The foreign key takes a brief SHARE ROW EXCLUSIVE lock on
-- `job_postings` (blocks its writes, not its reads, for the instant the constraint is added;
-- nothing to validate). Apply by hand in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;`
-- and retry on a lock timeout (55P03).
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs per table at the end are HAND-WRITTEN (the
-- 0117 / 0156 / 0160 / 0161 / 0167 / 0175 / 0178 / 0181 / 0184 pattern) - a regenerate drops them
-- silently. Registered in `schema-contract.ts` and listed in LOCKED_TABLES in the e2e RLS spine.
--
-- ROLLBACK (switch `ADMIN_JOB_AUDIENCE_ENABLED` off first; every recorded decision and the trade
-- list are lost, while every posting keeps the audience the admin set):
--   DROP TABLE "job_posting_audience_decisions";
--   DROP TABLE "campus_trades";
-- and delete this migration's row from drizzle.__drizzle_migrations (the one whose created_at
-- is this entry's journal `when`).
--
-- SAFE TO RE-RUN: no (plain CREATE TABLE). Apply once.
-- ==============================================================================
CREATE TABLE "campus_trades" (
	"trade_key" text PRIMARY KEY NOT NULL,
	"added_by_admin_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_by_admin_id" uuid,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campus_trades_key_chk" CHECK ("campus_trades"."trade_key" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "campus_trades_removed_chk" CHECK (("campus_trades"."removed_at" IS NULL) = ("campus_trades"."removed_by_admin_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "campus_trades" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "job_posting_audience_decisions" (
	"job_posting_id" uuid PRIMARY KEY NOT NULL,
	"audience" text NOT NULL,
	"content_hash" text NOT NULL,
	"decided_by_admin_id" uuid NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jpad_audience_chk" CHECK ("job_posting_audience_decisions"."audience" IN ('badabhai_workers', 'rvm_students', 'both')),
	CONSTRAINT "jpad_content_hash_chk" CHECK ("job_posting_audience_decisions"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "job_posting_audience_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job_posting_audience_decisions" ADD CONSTRAINT "job_posting_audience_decisions_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLEs above; FORCE and the REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 / 0161 / 0167 / 0178 / 0181 / 0184 pattern), because a
-- regenerate drops them.
-- ===========================================================================
ALTER TABLE "job_posting_audience_decisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "job_posting_audience_decisions" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "job_posting_audience_decisions" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "job_posting_audience_decisions" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "job_posting_audience_decisions" FROM service_role;--> statement-breakpoint
ALTER TABLE "campus_trades" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "campus_trades" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "campus_trades" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "campus_trades" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "campus_trades" FROM service_role;
