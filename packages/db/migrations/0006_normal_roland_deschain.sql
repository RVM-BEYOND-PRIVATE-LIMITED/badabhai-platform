ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "events_idempotency_key_uq" ON "events" USING btree ("idempotency_key");