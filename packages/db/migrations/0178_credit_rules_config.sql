-- ==============================================================================
-- credit_rules_config: the credit rules' settings, one row per revision (#2750 item 1)
-- ==============================================================================
--
-- (The header and the RLS tail below are HAND-WRITTEN and carry no migration number of their
-- own, so a regenerate under another slot keeps them word for word: re-prepend this header,
-- re-append the tail.)
--
-- #2750 item 1 (brief 4C.5 to 4C.12, section 7). Every number the credit rules use - what one
-- contact costs, the experience line for the higher cost, the welcome grant, the weekly and daily
-- opening limits, the couldn't-reach windows, returned credits, the refund rules, the goodwill cap
-- - as settings an admin edits with no deploy. The shape and the brief's defaults are
-- `CreditRulesSchema` in `@badabhai/pricing`; a stored row is validated on load and an invalid one
-- FAILS CLOSED, whole, to the defaults.
--
-- A SIBLING OF `match_config`, NOT NEW KEYS IN IT (owner ruling 2026-11-17): money rules never
-- share a row with the ranking knobs, so one bad edit can never move both.
--
-- APPEND-ONLY BY REVISION. `PUT /admin/credit-rules` inserts a new row and clears `is_active` on
-- the old one in the same transaction, with an `audit_logs` row (the reason, the admin) and an
-- `admin.action_performed` event. `credit_rules_config_active_uq` keeps at most one active row;
-- `credit_rules_config_revision_uq` makes two edits of one revision collide (one rolls back).
--
-- ADDITIVE ONLY. One new, EMPTY table and its two indexes; no existing column, constraint or row
-- moves. Nothing is seeded: with no row the API serves the brief's defaults (`source: "default"`).
--
-- DEPLOY ORDER - APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY. Nothing names this table while
-- CREDIT_RULES_ROLLOUT is off: the settings service is never asked, and both admin routes answer
-- 404. With the switch on before this file, the admin routes answer 503 and every rule reads the
-- brief's defaults (a 42P01 is treated as "no row", logged with its SQLSTATE). Apply every
-- lower-numbered migration first (slot order), then this, then set the switch.
--
-- LOCKS. A new table with no foreign key: nothing else is locked. Apply by hand in ONE
-- `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` all the same (the house rule).
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs at the end are HAND-WRITTEN (the
-- 0117 / 0156 / 0160 / 0161 / 0167 / 0175 pattern) - a regenerate drops them silently. Registered
-- as an `rls` entry in `schema-contract.ts`; listed in LOCKED_TABLES in the e2e RLS spine.
--
-- ROLLBACK (switch CREDIT_RULES_ROLLOUT off and redeploy first; every stored revision is lost and
-- the rules fall back to the brief's defaults):
--   DROP TABLE "credit_rules_config";
-- and delete this migration's row from drizzle.__drizzle_migrations (the one whose created_at
-- is this entry's journal `when`).
--
-- SAFE TO RE-RUN: no (plain CREATE TABLE). Apply once.
-- ==============================================================================
CREATE TABLE "credit_rules_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rules" jsonb NOT NULL,
	"revision" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_rules_config_revision_pos_chk" CHECK ("credit_rules_config"."revision" > 0),
	CONSTRAINT "credit_rules_config_rules_object_chk" CHECK (jsonb_typeof("credit_rules_config"."rules") = 'object')
);
--> statement-breakpoint
ALTER TABLE "credit_rules_config" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_rules_config_active_uq" ON "credit_rules_config" USING btree ("is_active") WHERE "credit_rules_config"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "credit_rules_config_revision_uq" ON "credit_rules_config" USING btree ("revision");
--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLE above; FORCE and the four REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 / 0161 / 0167 pattern), because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "credit_rules_config" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "credit_rules_config" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "credit_rules_config" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "credit_rules_config" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "credit_rules_config" FROM service_role;
