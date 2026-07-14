CREATE TABLE "skill_alias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" text NOT NULL,
	"text" text NOT NULL,
	"lang" text,
	"source" text NOT NULL,
	"domain_id" text NOT NULL,
	"embedding" vector(768),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_alias_source_chk" CHECK ("skill_alias"."source" IN ('esco', 'onet', 'nco', 'rvm'))
);
--> statement-breakpoint
ALTER TABLE "skill_alias" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "skill" (
	"skill_id" text PRIMARY KEY NOT NULL,
	"label_en" text NOT NULL,
	"label_hi" text,
	"domain_id" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'provisional' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_source_chk" CHECK ("skill"."source" IN ('esco', 'onet', 'nco', 'rvm')),
	CONSTRAINT "skill_status_chk" CHECK ("skill"."status" IN ('active', 'provisional', 'deprecated'))
);
--> statement-breakpoint
ALTER TABLE "skill" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "unresolved_phrase" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phrase" text NOT NULL,
	"lang" text,
	"domain_id" text,
	"count" integer DEFAULT 1 NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"embedding" vector(768),
	CONSTRAINT "unresolved_phrase_status_chk" CHECK ("unresolved_phrase"."status" IN ('open', 'clustered', 'resolved'))
);
--> statement-breakpoint
ALTER TABLE "unresolved_phrase" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_alias" ADD CONSTRAINT "skill_alias_skill_id_skill_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("skill_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_alias_domain_skill_idx" ON "skill_alias" USING btree ("domain_id","skill_id");--> statement-breakpoint
CREATE INDEX "skill_alias_skill_id_idx" ON "skill_alias" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "skill_alias_embedding_hnsw" ON "skill_alias" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "skill_domain_id_idx" ON "skill" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "unresolved_phrase_domain_id_idx" ON "unresolved_phrase" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "unresolved_phrase_status_idx" ON "unresolved_phrase" USING btree ("status");