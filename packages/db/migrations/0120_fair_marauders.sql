CREATE TABLE "relay_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unlock_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"kind" text NOT NULL,
	"template_id" text,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "relay_messages_direction_chk" CHECK ("relay_messages"."direction" IN ('payer_to_worker', 'worker_to_payer')),
	CONSTRAINT "relay_messages_kind_chk" CHECK ("relay_messages"."kind" IN ('template', 'text')),
	CONSTRAINT "relay_messages_body_shape_chk" CHECK (("relay_messages"."kind" = 'template' AND "relay_messages"."template_id" IS NOT NULL AND NOT ("relay_messages"."body" ? 'text')) OR ("relay_messages"."kind" = 'text' AND "relay_messages"."template_id" IS NULL AND NOT ("relay_messages"."body" ? 'template_id')))
);
--> statement-breakpoint
ALTER TABLE "relay_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "relay_messages" ADD CONSTRAINT "relay_messages_unlock_id_unlocks_id_fk" FOREIGN KEY ("unlock_id") REFERENCES "public"."unlocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "relay_messages_unlock_id_created_idx" ON "relay_messages" USING btree ("unlock_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "unlock_routing_relay_handle_uq" ON "unlock_routing" USING btree ("relay_handle");