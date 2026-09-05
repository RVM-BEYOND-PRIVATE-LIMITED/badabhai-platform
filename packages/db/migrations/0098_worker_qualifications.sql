-- ===========================================================================
-- 0098 — QUALIFICATIONS: the credentials a worker holds, and who issued them
--
-- !! THE JOURNAL `when` FOR THIS ENTRY IS PINNED. DO NOT REGENERATE BLINDLY. !!
--
-- `meta/_journal.json` carries when=1788331576411 for 0098. Running `drizzle-kit
-- generate` again stamps a NEW `when`, and because drizzle skips any entry whose `when`
-- is below MAX(created_at) in `__drizzle_migrations`, a re-stamped 0098 gets RE-RUN
-- against a database that already has these tables: it dies on "relation already exists"
-- and blocks every later migration behind it. Silently, on the deploy.
--
-- Two NEW, EMPTY tables. Nothing existing is touched: no column is added, dropped,
-- renamed or re-typed on any shipped table, no constraint is relaxed, no index is
-- rebuilt, no policy is changed. Rollback is two DROP TABLEs and the database is
-- byte-identical to 0097.
--
-- ===========================================================================
-- WHY ZONE 5 NEEDS THIS AND THE EXISTING SHAPE CANNOT CARRY IT
-- ===========================================================================
--   Education     ITI - Machinist · NCVT · 2018 · Govt. ITI, Faridabad
--   Certificates  CNC Turning & Fanuc Programming (RVM CAD, Faridabad, 2020)
--
-- EDUCATION is captured today as four scalar keys on `worker_attributes` -
-- `education_credential`, `education_council`, `education_year`, `education_institute`.
-- That table is keyed `(worker_id, attribute_key)`, so it holds EXACTLY ONE of each: a
-- worker with an ITI and a later diploma must overwrite one with the other. Meanwhile
-- `buildQualificationRows` already takes `education` as a LIST - the renderer has been
-- able to print several all along and the capture surface could only ever supply one.
--
-- CERTIFICATES are captured by no surface at all. The row prints from
-- `draft.certifications`, which only the LLM extraction path writes - and the trade-form
-- handover deliberately switches extraction OFF. So for every form-first worker the
-- Certificates row has no source and never appears, while `resume-degradation.ts`
-- carries a ladder step to drop a row that cannot exist. Both RVM student reference
-- sheets lead with a certificate.
--
-- ===========================================================================
-- TWO TABLES, NOT ONE `worker_qualification` WITH A `kind` COLUMN
-- ===========================================================================
-- They share a shape and not a meaning. An education has a council and a field of study;
-- a certificate has neither and is not awarded by a board. Merging them would make four
-- columns nullable-by-kind and put the real constraint ("a council belongs to an
-- education") somewhere no CHECK can see it. They are also read separately - two rows,
-- two places, two different degradation-ladder steps.
--
-- ===========================================================================
-- THE INSTITUTE AND THE ISSUER ARE STORED IN CLEAR - A DECISION, NOT AN OVERSIGHT
-- ===========================================================================
-- `worker_employment.employer_name_enc` (0094) is AES-256-GCM ciphertext because
-- "Ramesh worked at Sandhar from Jan 2023" is an employment record, and that is personal
-- data under DPDP even though the company name alone is not.
--
-- These columns follow the OTHER precedent - `education_institute`, which has shipped in
-- clear on `worker_attributes` since R9 section 3 - because they are the same field, in
-- the same zone, on the same page. Moving one behind encryption while its sibling stays
-- in clear is an inconsistency no reader could resolve. A credential attribution is also
-- not a tenure: "trained at RVM CAD" says nothing about where the worker was employed.
--
-- THE UNCOMFORTABLE CASE IS REAL AND IS NAMED HERE: an issuer CAN be an employer.
-- Ramesh's own sheet carries "Fire & Safety Awareness (Sandhar Technologies Ltd, 2023)",
-- which discloses an employer through the certificate row - though the same name already
-- prints from `worker_employment` two rows above. That is the argument FOR encrypting
-- these, and it is the security gate's ruling to make, not this migration's. Encrypting
-- later needs a backfill; that cost is accepted deliberately over shipping a zone whose
-- two halves disagree about their own threat model.
--
-- NEITHER TABLE CROSSES THE AI BOUNDARY. Both render deterministically through
-- `buildQualificationRows`, exactly as employer names do. `pseudonymize.py` is untouched.
--
-- ===========================================================================
-- WHAT THE CONSTRAINTS ENFORCE
-- ===========================================================================
--   wc_name_chk           A nameless certificate prints "(RVM CAD, 2020)" and nothing
--                         else. The column is NOT NULL and must be non-blank.
--   wc/wed_year_chk       1950..2100, the same bounds `education_year` already uses. A
--                         year in the future or before living memory is a typo, and a
--                         typo printed beside a real credential does more damage than a
--                         missing segment.
--   wed_not_empty_chk     Every column on an education row is individually optional - a
--                         worker may know their trade and not their council. All five
--                         null is a blank line the renderer would have to guess about,
--                         so the database refuses to store one.
--   *_sort_order_chk      Ordering is EXPLICIT, not derived from `year`. Two credentials
--                         can share a year and an undated one still has a place the
--                         worker gave it; sorting by year would reshuffle rows between
--                         renders and make every regenerated PDF a false diff.
-- ===========================================================================
CREATE TABLE "worker_certificate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"name" text NOT NULL,
	"issuer" text,
	"year" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wc_name_chk" CHECK (length(btrim("worker_certificate"."name")) BETWEEN 1 AND 120),
	CONSTRAINT "wc_issuer_len_chk" CHECK ("worker_certificate"."issuer" IS NULL OR length("worker_certificate"."issuer") <= 120),
	CONSTRAINT "wc_year_chk" CHECK ("worker_certificate"."year" IS NULL OR ("worker_certificate"."year" BETWEEN 1950 AND 2100)),
	CONSTRAINT "wc_sort_order_chk" CHECK ("worker_certificate"."sort_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "worker_certificate" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "worker_education" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"credential" text,
	"field" text,
	"council" text,
	"year" integer,
	"institute" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wed_not_empty_chk" CHECK ("worker_education"."credential" IS NOT NULL OR "worker_education"."field" IS NOT NULL OR "worker_education"."council" IS NOT NULL OR "worker_education"."year" IS NOT NULL OR "worker_education"."institute" IS NOT NULL),
	CONSTRAINT "wed_credential_len_chk" CHECK ("worker_education"."credential" IS NULL OR length("worker_education"."credential") <= 40),
	CONSTRAINT "wed_field_len_chk" CHECK ("worker_education"."field" IS NULL OR length("worker_education"."field") <= 80),
	CONSTRAINT "wed_council_len_chk" CHECK ("worker_education"."council" IS NULL OR length("worker_education"."council") <= 40),
	CONSTRAINT "wed_year_chk" CHECK ("worker_education"."year" IS NULL OR ("worker_education"."year" BETWEEN 1950 AND 2100)),
	CONSTRAINT "wed_institute_len_chk" CHECK ("worker_education"."institute" IS NULL OR length("worker_education"."institute") <= 120),
	CONSTRAINT "wed_sort_order_chk" CHECK ("worker_education"."sort_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "worker_education" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_certificate" ADD CONSTRAINT "worker_certificate_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_education" ADD CONSTRAINT "worker_education_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wc_worker_sort_uq" ON "worker_certificate" USING btree ("worker_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "wed_worker_sort_uq" ON "worker_education" USING btree ("worker_id","sort_order");--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT — RLS forced, every role revoked, and NO POLICY.
--
-- The same posture `worker_attributes` and `worker_employment` carry, and for the same
-- reason: nothing reaches these rows except the API's BYPASSRLS connection. FORCE
-- matters because it applies to the table OWNER too, so a future `postgres`-owned job
-- cannot read a worker's credentials by accident. A policy is not merely absent here —
-- with FORCE and no policy the table is closed, and any later policy is an explicit,
-- reviewable decision.
--
-- `drizzle-kit generate` emits only the ENABLE above. FORCE and the four REVOKEs are
-- hand-written, exactly as they were for 0094 — a regenerate drops them silently, which
-- is the second reason this file is not to be regenerated blindly.
-- ===========================================================================
ALTER TABLE "worker_certificate" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_certificate" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_certificate" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_certificate" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_certificate" FROM service_role;--> statement-breakpoint
ALTER TABLE "worker_education" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_education" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_education" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_education" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_education" FROM service_role;
