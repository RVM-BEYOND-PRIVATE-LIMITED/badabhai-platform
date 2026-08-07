CREATE TABLE "profiling_voice_answer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"voice_note_id" uuid,
	"pack_id" text NOT NULL,
	"pack_version" integer NOT NULL,
	"question_key" text NOT NULL,
	"attempt_no" smallint DEFAULT 1 NOT NULL,
	"ordinal" smallint NOT NULL,
	"capture_status" text DEFAULT 'recorded' NOT NULL,
	"transcript_status" text DEFAULT 'pending' NOT NULL,
	"transcript_error_code" text,
	"duration_seconds" integer,
	"superseded_at" timestamp with time zone,
	"superseded_by_id" uuid,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pva_question_key_chk" CHECK ("profiling_voice_answer"."question_key" ~ '^[a-z_]+$' AND length("profiling_voice_answer"."question_key") <= 40),
	CONSTRAINT "pva_pack_version_chk" CHECK ("profiling_voice_answer"."pack_version" >= 1),
	CONSTRAINT "pva_attempt_no_chk" CHECK ("profiling_voice_answer"."attempt_no" >= 1 AND "profiling_voice_answer"."attempt_no" <= 20),
	CONSTRAINT "pva_ordinal_chk" CHECK ("profiling_voice_answer"."ordinal" >= 0),
	CONSTRAINT "pva_capture_status_chk" CHECK ("profiling_voice_answer"."capture_status" IN ('recorded', 'uploaded', 'failed', 'abandoned')),
	CONSTRAINT "pva_transcript_status_chk" CHECK ("profiling_voice_answer"."transcript_status" IN ('pending', 'queued', 'succeeded', 'failed', 'skipped')),
	CONSTRAINT "pva_duration_chk" CHECK ("profiling_voice_answer"."duration_seconds" IS NULL OR ("profiling_voice_answer"."duration_seconds" >= 0 AND "profiling_voice_answer"."duration_seconds" <= 120)),
	CONSTRAINT "pva_superseded_by_self_chk" CHECK ("profiling_voice_answer"."superseded_by_id" IS NULL OR "profiling_voice_answer"."superseded_by_id" <> "profiling_voice_answer"."id"),
	CONSTRAINT "pva_superseded_pair_chk" CHECK (("profiling_voice_answer"."superseded_at" IS NULL AND "profiling_voice_answer"."superseded_by_id" IS NULL) OR ("profiling_voice_answer"."superseded_at" IS NOT NULL AND "profiling_voice_answer"."superseded_by_id" IS NOT NULL)),
	CONSTRAINT "pva_purged_ref_chk" CHECK ("profiling_voice_answer"."purged_at" IS NULL OR "profiling_voice_answer"."voice_note_id" IS NULL),
	CONSTRAINT "pva_error_code_chk" CHECK ("profiling_voice_answer"."transcript_error_code" IS NULL OR "profiling_voice_answer"."transcript_status" = 'failed')
);
--> statement-breakpoint
CREATE TABLE "worker_attributes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"attribute_key" text NOT NULL,
	"value_kind" text NOT NULL,
	"value_bool" boolean,
	"value_number" numeric(14, 4),
	"value_text" text,
	"value_text_list" jsonb,
	"source" text DEFAULT 'answer_map' NOT NULL,
	"question_key" text,
	"pack_id" text,
	"pack_version" integer,
	"session_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_attribute_key_chk" CHECK ("worker_attributes"."attribute_key" ~ '^[a-z_]+$' AND length("worker_attributes"."attribute_key") <= 40),
	CONSTRAINT "wa_value_kind_chk" CHECK ("worker_attributes"."value_kind" IN ('boolean', 'number', 'text', 'text_list')),
	CONSTRAINT "wa_source_chk" CHECK ("worker_attributes"."source" IN ('answer_map', 'llm_parse')),
	CONSTRAINT "wa_value_present_chk" CHECK ((
        ("worker_attributes"."value_kind" = 'boolean'   AND "worker_attributes"."value_bool" IS NOT NULL AND "worker_attributes"."value_number" IS NULL AND "worker_attributes"."value_text" IS NULL AND "worker_attributes"."value_text_list" IS NULL) OR
        ("worker_attributes"."value_kind" = 'number'    AND "worker_attributes"."value_number" IS NOT NULL AND "worker_attributes"."value_bool" IS NULL AND "worker_attributes"."value_text" IS NULL AND "worker_attributes"."value_text_list" IS NULL) OR
        ("worker_attributes"."value_kind" = 'text'      AND "worker_attributes"."value_text" IS NOT NULL AND "worker_attributes"."value_bool" IS NULL AND "worker_attributes"."value_number" IS NULL AND "worker_attributes"."value_text_list" IS NULL) OR
        ("worker_attributes"."value_kind" = 'text_list' AND "worker_attributes"."value_text_list" IS NOT NULL AND "worker_attributes"."value_bool" IS NULL AND "worker_attributes"."value_number" IS NULL AND "worker_attributes"."value_text" IS NULL)
      )),
	CONSTRAINT "wa_value_text_list_shape_chk" CHECK ("worker_attributes"."value_text_list" IS NULL OR jsonb_typeof("worker_attributes"."value_text_list") = 'array'),
	CONSTRAINT "wa_pack_pin_chk" CHECK (("worker_attributes"."pack_id" IS NULL AND "worker_attributes"."pack_version" IS NULL) OR ("worker_attributes"."pack_id" IS NOT NULL AND "worker_attributes"."pack_version" IS NOT NULL AND "worker_attributes"."pack_version" >= 1))
);
--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "pack_id" text;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "pack_version" integer;--> statement-breakpoint
ALTER TABLE "profiling_voice_answer" ADD CONSTRAINT "profiling_voice_answer_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiling_voice_answer" ADD CONSTRAINT "profiling_voice_answer_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiling_voice_answer" ADD CONSTRAINT "profiling_voice_answer_voice_note_id_voice_notes_id_fk" FOREIGN KEY ("voice_note_id") REFERENCES "public"."voice_notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiling_voice_answer" ADD CONSTRAINT "profiling_voice_answer_superseded_by_id_profiling_voice_answer_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."profiling_voice_answer"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_attributes" ADD CONSTRAINT "worker_attributes_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_attributes" ADD CONSTRAINT "worker_attributes_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pva_session_order_idx" ON "profiling_voice_answer" USING btree ("session_id","ordinal","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "pva_session_question_attempt_uq" ON "profiling_voice_answer" USING btree ("session_id","question_key","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "pva_session_question_live_uq" ON "profiling_voice_answer" USING btree ("session_id","question_key") WHERE superseded_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pva_voice_note_uq" ON "profiling_voice_answer" USING btree ("voice_note_id") WHERE voice_note_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "pva_worker_idx" ON "profiling_voice_answer" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "pva_pending_idx" ON "profiling_voice_answer" USING btree ("created_at") WHERE transcript_status IN ('pending', 'queued');--> statement-breakpoint
CREATE UNIQUE INDEX "wa_worker_key_uq" ON "worker_attributes" USING btree ("worker_id","attribute_key");--> statement-breakpoint
CREATE INDEX "wa_key_bool_idx" ON "worker_attributes" USING btree ("attribute_key","value_bool");--> statement-breakpoint
CREATE INDEX "voice_notes_created_at_idx" ON "voice_notes" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_pack_pin_chk" CHECK (("chat_sessions"."pack_id" IS NULL AND "chat_sessions"."pack_version" IS NULL) OR ("chat_sessions"."pack_id" IS NOT NULL AND "chat_sessions"."pack_version" IS NOT NULL AND "chat_sessions"."pack_version" >= 1));--> statement-breakpoint
-- Verbatim shape from 0069_ambitious_mentallo.sql's tail: ENABLE + FORCE, then REVOKE ALL from
-- every non-owner role. Zero policies, because the posture in this database is deny-by-default
-- and the backend connects with BYPASSRLS; writing a permissive policy here would change the
-- platform posture, not just this table.
--
-- `worker_attributes` holds trade facts keyed by an opaque worker_id — the same class as
-- `worker_profiles`, and a direct worker-linkage table. `profiling_voice_answer` holds opaque ids,
-- a question key and status; the transcript deliberately never lands here.
--
ALTER TABLE "worker_attributes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_attributes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_attributes" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_attributes" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_attributes" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_attributes" FROM service_role;--> statement-breakpoint
ALTER TABLE "profiling_voice_answer" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profiling_voice_answer" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "profiling_voice_answer" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "profiling_voice_answer" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "profiling_voice_answer" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "profiling_voice_answer" FROM service_role;
