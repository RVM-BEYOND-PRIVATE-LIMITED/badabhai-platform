ALTER TABLE "job_postings" ADD COLUMN "skill_phrases" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "skill_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
