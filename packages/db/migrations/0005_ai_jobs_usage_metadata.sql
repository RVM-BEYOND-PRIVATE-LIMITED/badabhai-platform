ALTER TABLE "ai_jobs" ADD COLUMN "model_name" text;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD COLUMN "real_call" boolean;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD COLUMN "total_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD COLUMN "cost_inr" double precision;