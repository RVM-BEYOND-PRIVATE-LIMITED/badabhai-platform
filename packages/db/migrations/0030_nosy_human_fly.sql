ALTER TABLE "worker_credentials" ADD COLUMN "otp_cycle_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "worker_credentials" ADD COLUMN "pepper_version" integer DEFAULT 1 NOT NULL;
-- ROLLBACK: ALTER TABLE "worker_credentials" DROP COLUMN "otp_cycle_count"; ALTER TABLE "worker_credentials" DROP COLUMN "pepper_version";