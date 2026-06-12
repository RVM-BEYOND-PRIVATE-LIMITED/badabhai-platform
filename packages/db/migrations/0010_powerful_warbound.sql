ALTER TABLE "generated_resumes" ADD COLUMN "template_id" text DEFAULT 'fallback' NOT NULL;--> statement-breakpoint
ALTER TABLE "generated_resumes" ADD COLUMN "source_profile_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "generated_resumes" ADD COLUMN "pdf_storage_key" text;--> statement-breakpoint
ALTER TABLE "generated_resumes" ADD COLUMN "render_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "generated_resumes" ADD COLUMN "rendered_at" timestamp with time zone;