-- ==============================================================================
-- numbers_weekly + numbers_recompute_log: the numbers screen's weekly snapshot (#2755 part B)
-- ==============================================================================
--
-- (The header and the RLS tail below are HAND-WRITTEN and carry no migration number of their
-- own, so a regenerate under another slot keeps them word for word: re-prepend this header,
-- re-append the tail.)
--
-- #2755 items 4, 5 and 11. `numbers_weekly` holds the CEO's weekly figures: one row per week x
-- metric x city group x trade group, the `all` roll-ups INCLUDED (computed from the source
-- rows, so a filter never adds suppressed cells together). A nightly sweep recomputes every week
-- from the baseline to the current one that is not frozen, one transaction per week (delete
-- then insert under an advisory lock), and freezes a week NUMBERS_FREEZE_AFTER_DAYS (default 3)
-- after it ends by setting `frozen_at`; it never touches a frozen week again. The first run
-- computes the past weeks from history (the baseline). GET /admin/numbers/weekly reads ONLY this
-- table. A worker cell under the floor of 5 is stored `suppressed` with every number NULL
-- (`numbers_weekly_suppressed_chk`), except the all x all total.
--
-- `numbers_recompute_log` is the recompute tool's record: a frozen week changes only through
-- `recompute-numbers.cli.ts --apply`, which rewrites the weeks and writes ONE row here in the
-- same transaction (weeks, definition version, rows changed, and the operator's reason in his
-- own words, 1..500 characters, `numbers_recompute_log_reason_chk`; never logged and never put
-- on an event).
--
-- AGGREGATES ONLY in `numbers_weekly`: counts, paise and the two terms of a ratio. No worker,
-- company, posting or order id; no name, phone or free text. `numbers_weekly_week_start_chk`
-- holds every week to its Monday.
--
-- KEYS. `numbers_weekly_pkey` (week_start, metric, city_group, trade_group) is the sweep's
-- delete-then-insert target, the freeze check and the route's window read. No other index:
-- the table is a few thousand rows a year.
--
-- ADDITIVE ONLY. Two new, empty tables; no existing column, constraint or row moves, and no
-- foreign key, so no lock is taken on any existing table.
--
-- DEPLOY ORDER - APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY. Nothing names either table
-- while ADMIN_NUMBERS_ENABLED (default false) is off: every /admin/numbers route is a 404 and
-- the sweep returns at once. With the switch on before this migration, GET
-- /admin/numbers/weekly answers 503 (42P01) and the sweep logs one warning per process and
-- writes nothing. Apply every lower-numbered migration first (slot order), then this, then arm
-- ADMIN_NUMBERS_ENABLED: the first sweep then backfills the history.
--
-- LOCKS. Two CREATE TABLEs, no foreign key: instant, and nothing else waits on them. Apply by
-- hand in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` all the same (the house
-- habit) and retry on 55P03.
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs per table at the end are HAND-WRITTEN
-- - a regenerate drops them silently. Registered as two `rls` entries in `schema-contract.ts`;
-- both tables are listed in LOCKED_TABLES in the e2e RLS spine.
--
-- ROLLBACK (switch ADMIN_NUMBERS_ENABLED off and redeploy first; the snapshot is lost - it is
-- rebuilt from the source tables by the next sweep after a re-apply, frozen weeks included -
-- and so is the recompute log):
--   DROP TABLE "numbers_weekly";
--   DROP TABLE "numbers_recompute_log";
-- and delete this migration's row from drizzle.__drizzle_migrations (the one whose created_at
-- is this entry's journal `when`).
--
-- SAFE TO RE-RUN: no (plain CREATE TABLE). Apply once.
-- ==============================================================================
CREATE TABLE "numbers_recompute_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"from_week" date NOT NULL,
	"to_week" date NOT NULL,
	"definition_version" integer NOT NULL,
	"reason" text NOT NULL,
	"rows_changed" integer NOT NULL,
	CONSTRAINT "numbers_recompute_log_actor_chk" CHECK ("numbers_recompute_log"."actor" IN ('cli')),
	CONSTRAINT "numbers_recompute_log_weeks_chk" CHECK ("numbers_recompute_log"."from_week" <= "numbers_recompute_log"."to_week"),
	CONSTRAINT "numbers_recompute_log_reason_chk" CHECK (char_length("numbers_recompute_log"."reason") BETWEEN 1 AND 500),
	CONSTRAINT "numbers_recompute_log_rows_changed_chk" CHECK ("numbers_recompute_log"."rows_changed" >= 0),
	CONSTRAINT "numbers_recompute_log_definition_version_chk" CHECK ("numbers_recompute_log"."definition_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "numbers_recompute_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "numbers_weekly" (
	"week_start" date NOT NULL,
	"metric" text NOT NULL,
	"city_group" text NOT NULL,
	"trade_group" text NOT NULL,
	"value" bigint,
	"numerator" bigint,
	"denominator" bigint,
	"suppressed" boolean DEFAULT false NOT NULL,
	"definition_version" integer NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"frozen_at" timestamp with time zone,
	CONSTRAINT "numbers_weekly_pkey" PRIMARY KEY("week_start","metric","city_group","trade_group"),
	CONSTRAINT "numbers_weekly_week_start_chk" CHECK (extract(isodow from "numbers_weekly"."week_start") = 1),
	CONSTRAINT "numbers_weekly_suppressed_chk" CHECK (NOT "numbers_weekly"."suppressed" OR ("numbers_weekly"."value" IS NULL AND "numbers_weekly"."numerator" IS NULL AND "numbers_weekly"."denominator" IS NULL)),
	CONSTRAINT "numbers_weekly_definition_version_chk" CHECK ("numbers_weekly"."definition_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "numbers_weekly" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY, on both tables.
-- `drizzle-kit generate` emits only the two ENABLEs above; FORCE and the four REVOKEs per
-- table are HAND-WRITTEN, because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "numbers_weekly" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "numbers_weekly" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "numbers_weekly" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "numbers_weekly" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "numbers_weekly" FROM service_role;--> statement-breakpoint
ALTER TABLE "numbers_recompute_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "numbers_recompute_log" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "numbers_recompute_log" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "numbers_recompute_log" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "numbers_recompute_log" FROM service_role;
