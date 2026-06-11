CREATE TABLE "profile_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_key" text NOT NULL,
	"question_text" text NOT NULL,
	"answer_type" text NOT NULL,
	"extraction_topic" text,
	"validation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"answer_text" text,
	"answer_number" double precision,
	"answer_date" date,
	"source" text DEFAULT 'chat' NOT NULL,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_answers_one_value_chk" CHECK ((
        ("worker_answers"."answer_text" IS NOT NULL)::int +
        ("worker_answers"."answer_number" IS NOT NULL)::int +
        ("worker_answers"."answer_date" IS NOT NULL)::int
      ) = 1)
);
--> statement-breakpoint
ALTER TABLE "profile_questions" ADD CONSTRAINT "profile_questions_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_questions" ADD CONSTRAINT "profile_questions_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_answers" ADD CONSTRAINT "worker_answers_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_answers" ADD CONSTRAINT "worker_answers_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_answers" ADD CONSTRAINT "worker_answers_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "profile_questions_profile_question_uq" ON "profile_questions" USING btree ("profile_id","question_id");--> statement-breakpoint
CREATE INDEX "profile_questions_profile_id_idx" ON "profile_questions" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_slug_uq" ON "profiles" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "questions_question_key_uq" ON "questions" USING btree ("question_key");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_answers_worker_question_uq" ON "worker_answers" USING btree ("worker_id","question_id");--> statement-breakpoint
CREATE INDEX "worker_answers_profile_id_idx" ON "worker_answers" USING btree ("profile_id");