CREATE TABLE "payer_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"member_payer_id" uuid,
	"email_enc" text NOT NULL,
	"email_hash" text NOT NULL,
	"org_role" text DEFAULT 'recruiter' NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"invited_by" uuid,
	"invite_token_hash" text,
	"invite_expires_at" timestamp with time zone,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payer_members_role_chk" CHECK ("payer_members"."org_role" IN ('owner', 'recruiter')),
	CONSTRAINT "payer_members_status_chk" CHECK ("payer_members"."status" IN ('invited', 'active', 'removed'))
);
--> statement-breakpoint
ALTER TABLE "payer_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payer_orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"root_payer_id" uuid NOT NULL,
	"name_enc" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payer_orgs_status_chk" CHECK ("payer_orgs"."status" IN ('active', 'suspended'))
);
--> statement-breakpoint
ALTER TABLE "payer_orgs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payer_members" ADD CONSTRAINT "payer_members_org_id_payer_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."payer_orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_members" ADD CONSTRAINT "payer_members_member_payer_id_payers_id_fk" FOREIGN KEY ("member_payer_id") REFERENCES "public"."payers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_members" ADD CONSTRAINT "payer_members_invited_by_payers_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."payers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_orgs" ADD CONSTRAINT "payer_orgs_root_payer_id_payers_id_fk" FOREIGN KEY ("root_payer_id") REFERENCES "public"."payers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payer_members_org_id_idx" ON "payer_members" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "payer_members_member_payer_id_idx" ON "payer_members" USING btree ("member_payer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payer_members_org_email_uq" ON "payer_members" USING btree ("org_id","email_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "payer_orgs_root_payer_id_uq" ON "payer_orgs" USING btree ("root_payer_id");--> statement-breakpoint
-- B5.1 backfill (ADR-0027): each existing payer becomes a SOLO org (root_payer_id = the
-- payer), carrying the payer's B2B org display name (ciphertext). Idempotent via the unique
-- root_payer_id, so a re-run is a no-op. Additive — no existing row is modified.
INSERT INTO "payer_orgs" ("root_payer_id", "name_enc", "status")
SELECT "id", "org_name_enc", 'active' FROM "payers"
ON CONFLICT ("root_payer_id") DO NOTHING;--> statement-breakpoint
-- Each solo org gets its founding payer as the single already-accepted OWNER member. The
-- member email mirrors the payer's own login email (encrypted at rest + keyed hash; TD21).
-- Idempotent via the unique (org_id, email_hash).
INSERT INTO "payer_members" ("org_id", "member_payer_id", "email_enc", "email_hash", "org_role", "status", "invited_at", "accepted_at")
SELECT o."id", p."id", p."email_enc", p."email_hash", 'owner', 'active', now(), now()
FROM "payer_orgs" o JOIN "payers" p ON p."id" = o."root_payer_id"
ON CONFLICT ("org_id", "email_hash") DO NOTHING;