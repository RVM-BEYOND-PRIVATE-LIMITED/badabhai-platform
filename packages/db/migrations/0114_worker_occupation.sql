-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 0114 — worker_occupation: the worker's declared SECONDARY occupations
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- ADR-0042 D9 / Layer A (f). One row per extra `role_*` id a worker declares, in the worker's
-- own order. The PRIMARY occupation stays where it has always been —
-- `worker_profiles.canonical_role_id` — and this table never replaces or overrides it.
--
-- WHAT IT IS FOR: display (the app reads the declared list back) and SUPPLY. Each id goes
-- through the SAME runtime role bridge (`ROLE_TO_MATCH_SKILL`) the primary already uses, so the
-- worker derives extra `worker_skill` rows. No new `mskill_*` vocabulary, no new rank key, no
-- change to the rank tuple: `deriveWorkerSkills` applies an existing bridge to one more
-- declared id. An id the bridge does not cover contributes no row and is display-only.
--
-- `wo_role_id_chk` is SHAPE ONLY (`^role_[a-z_]+$`) — role membership is the DTO's job against
-- the single `ROLES` constant in `@badabhai/taxonomy`, so a new role never needs a migration
-- (the same split 0110's `wl_language_chk` draws for the language dictionary).
--
-- ADDITIVE / BACKWARD-COMPATIBLE. One new, empty table; no shipped column moves; a worker with
-- no rows derives exactly what they derived before. Rollback is one statement:
--
--   DROP TABLE "worker_occupation";
--
-- APPLY-BEFORE-DEPLOY: `WorkerOccupationsRepository` names the table unconditionally on
-- PUT/GET /workers/me/occupations, and `WorkerSkillsRepository.findSecondaryRoleIds` names it
-- on every match rebuild, so both the endpoint and the rebuild 500/throw against a database
-- without it. Registered as `0114-worker-occupation-table` + `0114-worker-occupation-rls` in
-- `schema-contract.ts`; listed in `LOCKED_TABLES` in the e2e RLS spine.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE "worker_occupation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"role_id" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wo_role_id_chk" CHECK ("worker_occupation"."role_id" ~ '^role_[a-z_]+$' AND length("worker_occupation"."role_id") <= 60),
	CONSTRAINT "wo_sort_order_chk" CHECK ("worker_occupation"."sort_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "worker_occupation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_occupation" ADD CONSTRAINT "worker_occupation_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wo_worker_role_uq" ON "worker_occupation" USING btree ("worker_id","role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wo_worker_sort_uq" ON "worker_occupation" USING btree ("worker_id","sort_order");--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
--
-- The same posture `worker_language` (0110) and `worker_portfolio` (0113) carry, and for the
-- same reason: nothing reaches these rows except the API's BYPASSRLS connection. FORCE matters
-- because it applies to the table OWNER too. `drizzle-kit generate` emits only the ENABLE
-- above; FORCE and the four REVOKEs are hand-written, and a regenerate drops them silently -
-- the second reason this file must not be regenerated blindly.
-- ===========================================================================
ALTER TABLE "worker_occupation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_occupation" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_occupation" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_occupation" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_occupation" FROM service_role;