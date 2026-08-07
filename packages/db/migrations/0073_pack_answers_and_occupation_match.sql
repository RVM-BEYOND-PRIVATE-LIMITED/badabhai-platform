CREATE TABLE "worker_pack_answer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"chat_session_id" uuid,
	"pack_id" text NOT NULL,
	"pack_version" integer NOT NULL,
	"question_key" text NOT NULL,
	"answer_text" text,
	"answer_number" double precision,
	"answer_bool" boolean,
	"answer_option_keys" text[],
	"status" text DEFAULT 'answered' NOT NULL,
	"source" text DEFAULT 'chat' NOT NULL,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wpa_status_chk" CHECK ("worker_pack_answer"."status" IN ('answered', 'declined', 'unanswered')),
	CONSTRAINT "wpa_source_chk" CHECK ("worker_pack_answer"."source" IN ('chat', 'chip', 'form', 'ops')),
	CONSTRAINT "wpa_answer_shape_chk" CHECK (("worker_pack_answer"."status" = 'answered') = (
        ("worker_pack_answer"."answer_text" IS NOT NULL)::int
        + ("worker_pack_answer"."answer_number" IS NOT NULL)::int
        + ("worker_pack_answer"."answer_bool" IS NOT NULL)::int
        + ("worker_pack_answer"."answer_option_keys" IS NOT NULL)::int
        = 1
      ))
);
--> statement-breakpoint
ALTER TABLE "worker_pack_answer" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_profiles" DROP CONSTRAINT "worker_profiles_job_domain_match_status_chk";--> statement-breakpoint
ALTER TABLE "worker_profiles" ADD COLUMN "job_domain_match_layer" text;--> statement-breakpoint
ALTER TABLE "worker_pack_answer" ADD CONSTRAINT "worker_pack_answer_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_pack_answer" ADD CONSTRAINT "worker_pack_answer_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wpa_worker_question_uq" ON "worker_pack_answer" USING btree ("worker_id","pack_id","question_key");--> statement-breakpoint
CREATE INDEX "wpa_chat_session_idx" ON "worker_pack_answer" USING btree ("chat_session_id");--> statement-breakpoint
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_job_domain_match_layer_chk" CHECK ("worker_profiles"."job_domain_match_layer" IS NULL OR (
        "worker_profiles"."job_domain_match_layer" IN ('l0_exact', 'l1_skeleton', 'l2_trigram', 'l3_vector')
        AND "worker_profiles"."job_domain_match_status" LIKE 'matched%'
      ));--> statement-breakpoint
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_job_domain_match_status_chk" CHECK ("worker_profiles"."job_domain_match_status" IS NULL OR "worker_profiles"."job_domain_match_status" IN ('matched_auto', 'matched_llm', 'unmatched_below_floor', 'unmatched_llm_declined', 'unmatched_degraded', 'matched_lexical', 'matched_worker_confirmed'));--> statement-breakpoint
-- HAND-APPENDED, mirroring 0066_special_pyro.sql's tail. drizzle-kit models ENABLE (both
-- statements above) but not FORCE, and not the grant revocations. Without FORCE the table
-- OWNER bypasses every policy — and the backend connects as the owner, so ENABLE alone would
-- be decorative on the only connection that ever reads these tables.
--
-- `worker_profiles` was one of the last worker tables without RLS. It holds the canonicalized
-- profile of every worker on the platform, which is exactly the table the posture exists for.
ALTER TABLE "worker_pack_answer" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_pack_answer" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_pack_answer" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_pack_answer" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_pack_answer" FROM service_role;--> statement-breakpoint
ALTER TABLE "worker_profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_profiles" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_profiles" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_profiles" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_profiles" FROM service_role;