-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 0112 — worker_training + the PRIVATE licence fields on worker_certificate
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- ADR-0042 D9 / Layer A (d).
--
-- 1. `worker_training` — a course the worker ATTENDED (name, provider, year, worker order). Not a
--    certificate: an award has an issuer and can carry a licence; a training often has no document
--    at all. One new, empty table + the deny-by-default RLS tail.
--
-- 2. `worker_certificate.licence_number_enc` — AES-256-GCM ciphertext behind the same token-shape
--    CHECK as `workers.whatsapp_enc` (a plaintext number is a 23514). `licence_expiry` — a DATE,
--    day precision, no timezone arithmetic.
--
--    NEVER PUBLIC, NEVER EMPLOYER-VISIBLE. Both columns are read by the worker-self GET only; the
--    deterministic résumé composition (`resume-qualification-rows.ts`) names `name`/`issuer`/`year`
--    and nothing else, so neither value can reach a sheet. No backfill: the columns start NULL for
--    every existing certificate, which is the truth (nobody had recorded one).
--
-- ADDITIVE / BACKWARD-COMPATIBLE. One table, two nullable columns, one FK, one unique index, four
-- CHECKs. Old builds never name any of them. Reversible while no training row exists:
--
--   DROP TABLE "worker_training";
--   ALTER TABLE "worker_certificate" DROP CONSTRAINT "wc_licence_number_enc_token_chk";
--   ALTER TABLE "worker_certificate" DROP CONSTRAINT "wc_licence_expiry_chk";
--   ALTER TABLE "worker_certificate" DROP COLUMN "licence_number_enc";
--   ALTER TABLE "worker_certificate" DROP COLUMN "licence_expiry";
--
-- ORDERING. The new PUT (`WorkerQualificationsService`) names `worker_training` and both columns
-- unconditionally, so they are apply-before-deploy for the new endpoint; the EXISTING certificate
-- write path only gains columns, which old builds never name. Registered as
-- `0112-worker-training-table`, `0112-worker-training-rls` and
-- `0112-worker-certificate-licence-columns` in `schema-contract.ts`.
--
-- COST. The ALTERs on `worker_certificate` are catalog-only (nullable, no default); the CHECKs
-- validate existing rows by scan, all of which are NULL and therefore trivially valid.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE "worker_training" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"name" text NOT NULL,
	"provider" text,
	"year" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wt_name_chk" CHECK (length(btrim("worker_training"."name")) BETWEEN 1 AND 120),
	CONSTRAINT "wt_provider_len_chk" CHECK ("worker_training"."provider" IS NULL OR length("worker_training"."provider") <= 120),
	CONSTRAINT "wt_year_chk" CHECK ("worker_training"."year" IS NULL OR ("worker_training"."year" BETWEEN 1950 AND 2100)),
	CONSTRAINT "wt_sort_order_chk" CHECK ("worker_training"."sort_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "worker_training" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_certificate" ADD COLUMN "licence_number_enc" text;--> statement-breakpoint
ALTER TABLE "worker_certificate" ADD COLUMN "licence_expiry" date;--> statement-breakpoint
ALTER TABLE "worker_training" ADD CONSTRAINT "worker_training_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wt_worker_sort_uq" ON "worker_training" USING btree ("worker_id","sort_order");--> statement-breakpoint
ALTER TABLE "worker_certificate" ADD CONSTRAINT "wc_licence_number_enc_token_chk" CHECK ("worker_certificate"."licence_number_enc" IS NULL OR "worker_certificate"."licence_number_enc" ~ '^(v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+|v2\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+)$');--> statement-breakpoint
ALTER TABLE "worker_certificate" ADD CONSTRAINT "wc_licence_expiry_chk" CHECK ("worker_certificate"."licence_expiry" IS NULL OR "worker_certificate"."licence_expiry" >= DATE '1950-01-01');--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
--
-- `worker_certificate` and `worker_education` carry the same tail from 0098. drizzle-kit emits
-- only the ENABLE above; FORCE and the four REVOKEs are hand-written, and a regenerate drops
-- them silently.
-- ===========================================================================
ALTER TABLE "worker_training" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_training" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_training" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_training" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_training" FROM service_role;
