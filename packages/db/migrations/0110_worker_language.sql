-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 0110 — worker_language: which languages a worker speaks, reads and writes
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- ADR-0042 D9 / Layer A (b). The `languages` attribute (`worker_attributes.value_text_list`) is
-- a bare list of slugs and cannot say HOW the worker knows each language; the résumé has had
-- only that list for its Languages row. This table is the richer, worker-owned source: one row
-- per language, three independent ticks (speak / read / write), worker-chosen order.
--
-- SLUG MEMBERSHIP IS THE DTO's JOB (`LANGUAGES` in `worker-preferences.vocabulary.ts`, the same
-- 16 slugs the finishing form offers). The CHECKs here are shape and coherence only:
--
--   wl_language_chk    the platform's slug convention, one short token
--   wl_ability_chk     at least one tick, or the row says nothing
--   wl_sort_order_chk  a position, never negative
--   wl_worker_language_uq / wl_worker_sort_uq  one row per language and per position
--
-- ADDITIVE / BACKWARD-COMPATIBLE. One new, empty table; no shipped column moves. The `languages`
-- attribute keeps being written and read, and the sheet prefers this table per-field where it
-- has rows (`tradeSheet.qualification?.languages ?? preferences.languages` already resolves
-- with `??`), so a worker who never opens the new surface renders exactly as today.
--
-- Rollback (safe with the app live, though the new PUT 500s until the app reverts):
--   DROP TABLE "worker_language";
--
-- NOT APPLY-BEFORE-DEPLOY-OR-ELSE-500 on the read path: the ONLY readers are the new languages
-- surfaces and the render processor's own load, which degrades on failure to the attribute list.
-- It IS apply-before-the-new-PUT: `WorkerLanguagesRepository` names the table unconditionally,
-- so the new endpoint 500s against a database without it. Registered as `0110-worker-language-
-- table` + `0110-worker-language-rls` in `schema-contract.ts`.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE "worker_language" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"language" text NOT NULL,
	"can_speak" boolean DEFAULT false NOT NULL,
	"can_read" boolean DEFAULT false NOT NULL,
	"can_write" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wl_language_chk" CHECK ("worker_language"."language" ~ '^[a-z_]+$' AND length("worker_language"."language") <= 40),
	CONSTRAINT "wl_ability_chk" CHECK ("worker_language"."can_speak" OR "worker_language"."can_read" OR "worker_language"."can_write"),
	CONSTRAINT "wl_sort_order_chk" CHECK ("worker_language"."sort_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "worker_language" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_language" ADD CONSTRAINT "worker_language_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wl_worker_language_uq" ON "worker_language" USING btree ("worker_id","language");--> statement-breakpoint
CREATE UNIQUE INDEX "wl_worker_sort_uq" ON "worker_language" USING btree ("worker_id","sort_order");--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
--
-- The same posture `worker_certificate` and `worker_education` carry (0098), and for the
-- same reason: nothing reaches these rows except the API's BYPASSRLS connection. FORCE
-- matters because it applies to the table OWNER too. `drizzle-kit generate` emits only the
-- ENABLE above; FORCE and the four REVOKEs are hand-written, and a regenerate drops them
-- silently - the second reason this file must not be regenerated blindly.
-- ===========================================================================
ALTER TABLE "worker_language" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_language" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_language" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_language" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_language" FROM service_role;
