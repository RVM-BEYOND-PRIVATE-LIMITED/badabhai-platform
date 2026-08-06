CREATE TABLE "profiling_family" (
	"family_id" text PRIMARY KEY NOT NULL,
	"label_en" text NOT NULL,
	"label_hi" text,
	"canonical_role_id" text,
	"industry_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"replaced_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiling_family_id_chk" CHECK ("profiling_family"."family_id" ~ '^fam_[a-z0-9_]+$'),
	CONSTRAINT "profiling_family_status_chk" CHECK ("profiling_family"."status" IN ('active', 'draft', 'deprecated')),
	CONSTRAINT "profiling_family_version_chk" CHECK ("profiling_family"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "profiling_family_binding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" text NOT NULL,
	"job_domain_id" text,
	"isco_unit_code" text,
	"isco_minor_code" text,
	"isco_submajor_code" text,
	"isco_major_code" text,
	"is_universal" boolean DEFAULT false NOT NULL,
	"specificity" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pfb_exactly_one_target_chk" CHECK ((
        (CASE WHEN "profiling_family_binding"."job_domain_id"       IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN "profiling_family_binding"."isco_unit_code"      IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN "profiling_family_binding"."isco_minor_code"     IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN "profiling_family_binding"."isco_submajor_code"  IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN "profiling_family_binding"."isco_major_code"     IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN "profiling_family_binding"."is_universal"       THEN 1 ELSE 0 END)
      ) = 1),
	CONSTRAINT "pfb_specificity_matches_target_chk" CHECK ((
        ("profiling_family_binding"."job_domain_id"      IS NOT NULL AND "profiling_family_binding"."specificity" = 50) OR
        ("profiling_family_binding"."isco_unit_code"     IS NOT NULL AND "profiling_family_binding"."specificity" = 40) OR
        ("profiling_family_binding"."isco_minor_code"    IS NOT NULL AND "profiling_family_binding"."specificity" = 30) OR
        ("profiling_family_binding"."isco_submajor_code" IS NOT NULL AND "profiling_family_binding"."specificity" = 20) OR
        ("profiling_family_binding"."isco_major_code"    IS NOT NULL AND "profiling_family_binding"."specificity" = 10) OR
        ("profiling_family_binding"."is_universal"      AND "profiling_family_binding"."specificity" = 0)
      ))
);
--> statement-breakpoint
CREATE TABLE "question_pack_item" (
	"item_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_id" text NOT NULL,
	"pack_version" integer NOT NULL,
	"question_key" text NOT NULL,
	"display_order" integer NOT NULL,
	"prompt_text" text NOT NULL,
	"why_text" text,
	"retry_text" text,
	"target_kind" text NOT NULL,
	"target_field" text,
	"target_skill_id" text,
	"answer_type" text NOT NULL,
	"is_mandatory" boolean DEFAULT false NOT NULL,
	"is_core" boolean DEFAULT false NOT NULL,
	"max_asks" smallint DEFAULT 2 NOT NULL,
	"min_turn" smallint,
	"max_turn" smallint,
	"ask_if" jsonb,
	"skip_if" jsonb,
	"parent_item_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qpi_question_key_chk" CHECK ("question_pack_item"."question_key" ~ '^[a-z_]+$' AND length("question_pack_item"."question_key") <= 40),
	CONSTRAINT "qpi_target_kind_chk" CHECK ("question_pack_item"."target_kind" IN ('rfs', 'match_skill', 'attribute', 'none')),
	CONSTRAINT "qpi_target_present_chk" CHECK ((
        ("question_pack_item"."target_kind" = 'none') OR
        ("question_pack_item"."target_kind" = 'match_skill' AND "question_pack_item"."target_skill_id" IS NOT NULL) OR
        ("question_pack_item"."target_kind" IN ('rfs', 'attribute') AND "question_pack_item"."target_field" IS NOT NULL)
      )),
	CONSTRAINT "qpi_answer_type_chk" CHECK ("question_pack_item"."answer_type" IN ('text', 'number', 'boolean', 'single_select', 'multi_select', 'city', 'salary', 'duration')),
	CONSTRAINT "qpi_max_asks_chk" CHECK ("question_pack_item"."max_asks" >= 1 AND "question_pack_item"."max_asks" <= 3),
	CONSTRAINT "qpi_display_order_chk" CHECK ("question_pack_item"."display_order" >= 0),
	CONSTRAINT "qpi_turn_window_chk" CHECK ("question_pack_item"."min_turn" IS NULL OR "question_pack_item"."max_turn" IS NULL OR "question_pack_item"."min_turn" <= "question_pack_item"."max_turn")
);
--> statement-breakpoint
CREATE TABLE "question_pack_option" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"option_key" text NOT NULL,
	"display_order" integer NOT NULL,
	"label_text" text NOT NULL,
	"value_text" text,
	"value_number" integer,
	"value_bool" boolean,
	"implies_skill_id" text,
	"is_none_of_above" boolean DEFAULT false NOT NULL,
	CONSTRAINT "qpo_option_key_chk" CHECK ("question_pack_option"."option_key" ~ '^[a-z0-9_]+$'),
	CONSTRAINT "qpo_display_order_chk" CHECK ("question_pack_option"."display_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "question_pack" (
	"pack_id" text NOT NULL,
	"version" integer NOT NULL,
	"family_id" text NOT NULL,
	"locale" text DEFAULT 'hi-IN' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"content_hash" text,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_pack_pkey" PRIMARY KEY("pack_id","version"),
	CONSTRAINT "question_pack_id_chk" CHECK ("question_pack"."pack_id" ~ '^qp_[a-z0-9_]+$'),
	CONSTRAINT "question_pack_version_chk" CHECK ("question_pack"."version" >= 1),
	CONSTRAINT "question_pack_status_chk" CHECK ("question_pack"."status" IN ('active', 'draft', 'deprecated'))
);
--> statement-breakpoint
ALTER TABLE "profiling_family" ADD CONSTRAINT "profiling_family_replaced_by_profiling_family_family_id_fk" FOREIGN KEY ("replaced_by") REFERENCES "public"."profiling_family"("family_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiling_family_binding" ADD CONSTRAINT "profiling_family_binding_family_id_profiling_family_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."profiling_family"("family_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_pack_item" ADD CONSTRAINT "qpi_pack_fk" FOREIGN KEY ("pack_id","pack_version") REFERENCES "public"."question_pack"("pack_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_pack_option" ADD CONSTRAINT "question_pack_option_item_id_question_pack_item_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."question_pack_item"("item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_pack" ADD CONSTRAINT "question_pack_family_id_profiling_family_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."profiling_family"("family_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profiling_family_status_idx" ON "profiling_family" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "pfb_job_domain_uq" ON "profiling_family_binding" USING btree ("job_domain_id") WHERE "profiling_family_binding"."job_domain_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pfb_isco_unit_uq" ON "profiling_family_binding" USING btree ("isco_unit_code") WHERE "profiling_family_binding"."isco_unit_code" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pfb_isco_minor_uq" ON "profiling_family_binding" USING btree ("isco_minor_code") WHERE "profiling_family_binding"."isco_minor_code" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pfb_isco_submajor_uq" ON "profiling_family_binding" USING btree ("isco_submajor_code") WHERE "profiling_family_binding"."isco_submajor_code" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pfb_isco_major_uq" ON "profiling_family_binding" USING btree ("isco_major_code") WHERE "profiling_family_binding"."isco_major_code" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pfb_universal_uq" ON "profiling_family_binding" USING btree ("is_universal") WHERE "profiling_family_binding"."is_universal";--> statement-breakpoint
CREATE INDEX "pfb_family_idx" ON "profiling_family_binding" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "pfb_specificity_idx" ON "profiling_family_binding" USING btree ("specificity");--> statement-breakpoint
CREATE UNIQUE INDEX "qpi_pack_question_uq" ON "question_pack_item" USING btree ("pack_id","pack_version","question_key");--> statement-breakpoint
CREATE INDEX "qpi_pack_idx" ON "question_pack_item" USING btree ("pack_id","pack_version");--> statement-breakpoint
CREATE UNIQUE INDEX "qpo_item_key_uq" ON "question_pack_option" USING btree ("item_id","option_key");--> statement-breakpoint
CREATE UNIQUE INDEX "qpo_item_label_uq" ON "question_pack_option" USING btree ("item_id","label_text");--> statement-breakpoint
CREATE INDEX "qpo_item_idx" ON "question_pack_option" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "question_pack_active_uq" ON "question_pack" USING btree ("family_id","locale") WHERE "question_pack"."status" = 'active';--> statement-breakpoint
CREATE INDEX "question_pack_family_idx" ON "question_pack" USING btree ("family_id");-- Verbatim shape from 0066_special_pyro.sql's tail: ENABLE + FORCE, then REVOKE ALL from
-- every non-owner role. These five tables hold no worker data, but the posture is
-- table-default in this database rather than opt-in, and a reference table left readable
-- by `anon` is how a catalogue becomes a public API nobody meant to publish.
--
ALTER TABLE "profiling_family" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profiling_family" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "profiling_family" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "profiling_family" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "profiling_family" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "profiling_family" FROM service_role;--> statement-breakpoint
ALTER TABLE "profiling_family_binding" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profiling_family_binding" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "profiling_family_binding" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "profiling_family_binding" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "profiling_family_binding" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "profiling_family_binding" FROM service_role;--> statement-breakpoint
ALTER TABLE "question_pack" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "question_pack" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "question_pack" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "question_pack" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "question_pack" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "question_pack" FROM service_role;--> statement-breakpoint
ALTER TABLE "question_pack_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "question_pack_item" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "question_pack_item" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "question_pack_item" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "question_pack_item" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "question_pack_item" FROM service_role;--> statement-breakpoint
ALTER TABLE "question_pack_option" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "question_pack_option" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "question_pack_option" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "question_pack_option" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "question_pack_option" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "question_pack_option" FROM service_role;
