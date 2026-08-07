ALTER TABLE "workers" ADD COLUMN "notifications_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "notifications_read_at" timestamp with time zone;