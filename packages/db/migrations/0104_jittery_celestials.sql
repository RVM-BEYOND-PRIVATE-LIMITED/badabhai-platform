ALTER TABLE "admin_users" ADD COLUMN "invite_token_hash" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "invite_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_invite_token_hash_uq" ON "admin_users" USING btree ("invite_token_hash") WHERE "admin_users"."invite_token_hash" IS NOT NULL;