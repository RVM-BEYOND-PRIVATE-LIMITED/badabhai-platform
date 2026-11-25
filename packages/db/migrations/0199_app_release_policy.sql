-- ===========================================================================
-- 0199 - the minimum supported app build (#3048, trades v2)
-- ===========================================================================
--
-- (The header and the seed + RLS tail below are HAND-WRITTEN and carry no migration number of
-- their own, so a regenerate under another slot keeps them word for word: re-prepend this header,
-- re-append the tail.)
--
-- Neither app could be told it is too old, so every server change had to keep the oldest
-- installed copy working. One row per app ('worker', 'payer') and platform ('android', 'ios'):
--   - `min_supported_build`: a build below it gets 426 on every mutating route (the global
--     MinAppBuildGuard) and the apps' "Update required" page (#3049). 0 blocks nobody.
--   - `latest_build`: below it (but not below the minimum) the apps show a dismissible notice.
--   - `store_url`: where the update button goes; null until the owner sets it.
--   - `message_key`: a copy key the apps map to text.
--   `updated_by` is the admin's id (null for the seed). Rows are never inserted or deleted after
--   the seed: the admin PUT updates one in place and `app_version.policy_changed` is the history.
--
-- ADDITIVE. One new table; no existing column, constraint or row moves. The seed writes the four
-- rows at minimum 0, so behaviour on the day of deploy is exactly today's: nothing gets a 426.
--
-- DEPLOY ORDER - EITHER ORDER IS SAFE. The guard fails OPEN on a missing table (a read error
-- answers "no minimum" and logs), GET /app-config answers 503 (the apps let the user in), and the
-- admin routes answer 503. Apply it before the owner needs to raise a minimum.
--
-- LOCKS. The table is new and the seed is 4 rows. Apply by hand in ONE
-- `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` and retry on a lock timeout (55P03).
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs at the end are HAND-WRITTEN (the 0117 /
-- 0156 / 0181 / 0198 pattern) - a regenerate drops them. Registered as
-- `0199-app-release-policy-rls` in `schema-contract.ts` and listed in LOCKED_TABLES in the e2e RLS
-- spine.
--
-- ROLLBACK (no minimum is enforced once the table is gone - the guard fails open):
--   DROP TABLE "app_release_policy";
-- and delete this migration's row from drizzle.__drizzle_migrations (the one whose created_at
-- is this entry's journal `when`).
--
-- SAFE TO RE-RUN: no (plain CREATE TABLE + seed). Apply once.
-- ===========================================================================
CREATE TABLE "app_release_policy" (
	"app" text NOT NULL,
	"platform" text NOT NULL,
	"min_supported_build" integer DEFAULT 0 NOT NULL,
	"latest_build" integer DEFAULT 0 NOT NULL,
	"store_url" text,
	"message_key" text DEFAULT 'update_default' NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_release_policy_pk" PRIMARY KEY("app","platform"),
	CONSTRAINT "app_release_policy_app_chk" CHECK ("app_release_policy"."app" IN ('worker', 'payer')),
	CONSTRAINT "app_release_policy_platform_chk" CHECK ("app_release_policy"."platform" IN ('android', 'ios')),
	CONSTRAINT "app_release_policy_builds_chk" CHECK ("app_release_policy"."min_supported_build" >= 0 AND "app_release_policy"."latest_build" >= "app_release_policy"."min_supported_build"),
	CONSTRAINT "app_release_policy_message_key_chk" CHECK ("app_release_policy"."message_key" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "app_release_policy_store_url_chk" CHECK ("app_release_policy"."store_url" IS NULL OR ("app_release_policy"."store_url" ~ '^https://' AND length("app_release_policy"."store_url") <= 512))
);
--> statement-breakpoint
ALTER TABLE "app_release_policy" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO "app_release_policy" ("app", "platform", "min_supported_build", "latest_build") VALUES
	('worker', 'android', 0, 0),
	('worker', 'ios', 0, 0),
	('payer', 'android', 0, 0),
	('payer', 'ios', 0, 0);
--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLE above; FORCE and the REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0181 / 0198 pattern), because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "app_release_policy" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "app_release_policy" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "app_release_policy" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "app_release_policy" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "app_release_policy" FROM service_role;
