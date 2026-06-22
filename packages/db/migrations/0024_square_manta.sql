ALTER TABLE "job_postings" ADD COLUMN "payer_id" uuid;--> statement-breakpoint
CREATE INDEX "job_postings_payer_id_idx" ON "job_postings" USING btree ("payer_id","created_at");