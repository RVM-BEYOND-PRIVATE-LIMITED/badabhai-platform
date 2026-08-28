-- ===========================================================================
-- 0094 — WORK HISTORY: employers, and the roles held inside them
--
-- !! THE JOURNAL `when` FOR THIS ENTRY IS PINNED. DO NOT REGENERATE BLINDLY. !!
--
-- `meta/_journal.json` carries when=1787749973672 for 0094, which is the value this
-- migration was ACTUALLY APPLIED under on 2026-08-28. Running `drizzle-kit generate`
-- again stamps a NEW `when`, and because drizzle skips any entry whose `when` is below
-- MAX(created_at) in `__drizzle_migrations`, a re-stamped 0094 gets RE-RUN against a
-- database that already has these tables: it dies on "relation already exists" and
-- blocks every later migration behind it. Silently, on the deploy.
--
-- If you regenerate this file, pin `when` back to 1787749973672 before committing, and
-- diff the executable DDL (comments and whitespace stripped) against what is here — the
-- only legitimate change is formatting. There is no schema<->migration drift gate in CI
-- to catch it for you: supabase-checks.yml is disabled_manually (TD97).
--
-- Two NEW, EMPTY tables. Nothing existing is touched: no column is added, dropped,
-- renamed or re-typed on any shipped table, no constraint is relaxed, no index is
-- rebuilt, no policy is changed. Rollback is two DROP TABLEs and the database is
-- byte-identical to 0093.
--
-- ===========================================================================
-- WHY THE RESUME NEEDS THIS AND THE EXISTING SHAPE CANNOT CARRY IT
-- ===========================================================================
-- `resume_profile.experiences[]` — the shape every profile has today — is a role, a
-- duration in the worker's own words, and what they did. It carries NO EMPLOYER by
-- contract: `ExperienceEntrySchema` is `.strict()` and the pseudonymisation gateway
-- masks employers to `[EMPLOYER_n]` before any model sees a transcript, so there is no
-- field for one and nothing upstream could fill it.
--
-- The ratified resume design prints employer, city and a date range for up to four
-- employers, and prints a PROMOTION inside one employer as two dated role lines under a
-- single company (design guideline §11 #14). Neither is expressible as a flat list.
--
-- The value therefore arrives from a question the WORKER TYPES, straight into Postgres,
-- and never through the AI service. That is the owner ruling of 2026-08-28 and the
-- gateway mask stays exactly as it is — this migration does not weaken it, it routes
-- around it.
--
--     workers 1 --< worker_employment 1 --< worker_employment_role
--
-- ===========================================================================
-- THE EMPLOYER NAME IS ENCRYPTED AT REST
-- ===========================================================================
-- Same AES-256-GCM token as `workers.full_name` and `workers.phone_e164`, written and
-- read only by `PiiCryptoService`. "Ramesh worked at Sandhar Technologies from Jan 2023"
-- is personal data about a worker under DPDP even though the company name alone is not,
-- and this is the first table to hold a worker's employment record.
--
-- THE COST IS STATED PLAINLY, because it is real and it is permanent-ish: an encrypted
-- column cannot be indexed, grouped or joined. No "how many of our workers came from
-- Sandhar", no employer dedupe, and an EPFO tenure-verification pass (§10 tier 3) would
-- have to decrypt row by row. Those are all deliberately out of scope; if any of them
-- becomes a product requirement, the answer is a SEPARATE canonical `employer` table
-- with a surrogate id — not decrypting this column.
--
-- `employer_city` and `employer_state` are NOT encrypted: they are already printed on
-- the résumé and on the payer-facing disclosure, and a city is not an identifier.
--
-- ===========================================================================
-- WHAT THE CONSTRAINTS ENFORCE, AND WHICH RULING EACH ONE COMES FROM
-- ===========================================================================
--   we_employer_name_present_chk   §11 #4: contract or thekedar work with no company
--                                  name renders the site or plant, else the literal
--                                  "contract work". The field is NEVER blank and is
--                                  NEVER invented — so the column is NOT NULL and the
--                                  caller must have decided which of the two it is.
--   we_ym_format_chk               A month is 'YYYY-MM' or it is absent. Free text here
--                                  becomes an unparseable date on a printed page.
--   we_ym_order_chk                An end before its start is a typo, not a tenure. Only
--                                  checked when BOTH are present.
--   we_end_open_chk                A NULL `end_ym` means "present", which is a real and
--                                  common state — not missing data. `duration_stated`
--                                  distinguishes it from §11 #3's "duration not stated",
--                                  which must never be rendered as a guess.
--   wer_ym_*                       The same three rules for a role stint, because a
--                                  promotion carries its own dates (§11 #14).
--
-- ORDERING IS EXPLICIT, NOT DERIVED. `sort_order` exists because a worker with two jobs
-- that both started in the same month, or two undated stints, still has an order they
-- described them in — and a résumé that reshuffles between renders is a false diff.
-- ===========================================================================
CREATE TABLE "worker_employment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"employer_name_enc" text NOT NULL,
	"employer_city" text,
	"employer_state" text,
	"start_ym" text,
	"end_ym" text,
	"duration_stated" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "we_employer_name_present_chk" CHECK (length(btrim("worker_employment"."employer_name_enc")) > 0),
	CONSTRAINT "we_city_len_chk" CHECK ("worker_employment"."employer_city" IS NULL OR length("worker_employment"."employer_city") <= 80),
	CONSTRAINT "we_state_len_chk" CHECK ("worker_employment"."employer_state" IS NULL OR length("worker_employment"."employer_state") <= 80),
	CONSTRAINT "we_ym_format_chk" CHECK (("worker_employment"."start_ym" IS NULL OR "worker_employment"."start_ym" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$') AND ("worker_employment"."end_ym" IS NULL OR "worker_employment"."end_ym" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')),
	CONSTRAINT "we_ym_order_chk" CHECK ("worker_employment"."start_ym" IS NULL OR "worker_employment"."end_ym" IS NULL OR "worker_employment"."end_ym" >= "worker_employment"."start_ym"),
	CONSTRAINT "we_duration_stated_chk" CHECK ("worker_employment"."duration_stated" = false OR "worker_employment"."start_ym" IS NOT NULL),
	CONSTRAINT "we_sort_order_chk" CHECK ("worker_employment"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "worker_employment_role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employment_id" uuid NOT NULL,
	"role_label" text NOT NULL,
	"start_ym" text,
	"end_ym" text,
	"work_done" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wer_role_label_chk" CHECK (length(btrim("worker_employment_role"."role_label")) BETWEEN 1 AND 80),
	CONSTRAINT "wer_work_done_len_chk" CHECK ("worker_employment_role"."work_done" IS NULL OR length("worker_employment_role"."work_done") <= 300),
	CONSTRAINT "wer_ym_format_chk" CHECK (("worker_employment_role"."start_ym" IS NULL OR "worker_employment_role"."start_ym" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$') AND ("worker_employment_role"."end_ym" IS NULL OR "worker_employment_role"."end_ym" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')),
	CONSTRAINT "wer_ym_order_chk" CHECK ("worker_employment_role"."start_ym" IS NULL OR "worker_employment_role"."end_ym" IS NULL OR "worker_employment_role"."end_ym" >= "worker_employment_role"."start_ym"),
	CONSTRAINT "wer_sort_order_chk" CHECK ("worker_employment_role"."sort_order" >= 0)
);
--> statement-breakpoint
-- CASCADE on both edges. An employment is meaningless without its worker and a role
-- stint is meaningless without its employment; ADR-0031 account deletion already relies
-- on `workers` cascading, and a stint left behind by a deleted employment would be an
-- orphaned employment record the DSAR sweep cannot see.
ALTER TABLE "worker_employment" ADD CONSTRAINT "worker_employment_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_employment_role" ADD CONSTRAINT "worker_employment_role_employment_id_worker_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."worker_employment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The only read this table has is "give me one worker's history, in display order", which
-- is exactly this index. Same for the stints under one employment.
CREATE UNIQUE INDEX "we_worker_sort_uq" ON "worker_employment" USING btree ("worker_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "wer_employment_sort_uq" ON "worker_employment_role" USING btree ("employment_id","sort_order");--> statement-breakpoint
ALTER TABLE "worker_employment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_employment_role" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT — RLS forced, every role revoked, and NO POLICY.
--
-- The same posture `worker_attributes` carries and for the same reason: nothing reaches
-- these rows except the API's BYPASSRLS connection. FORCE matters because it applies to
-- the table OWNER too, so a future `postgres`-owned job cannot read a worker's
-- employment record by accident. A policy is not merely absent here — with FORCE and no
-- policy the table is closed, and any later policy is an explicit, reviewable decision.
-- ===========================================================================
ALTER TABLE "worker_employment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_employment" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_employment" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_employment" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_employment" FROM service_role;--> statement-breakpoint
ALTER TABLE "worker_employment_role" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_employment_role" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_employment_role" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_employment_role" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_employment_role" FROM service_role;
