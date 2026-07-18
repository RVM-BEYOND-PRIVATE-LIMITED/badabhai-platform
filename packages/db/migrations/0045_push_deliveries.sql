-- ADR-0034 — server-initiated push notifications (worker app, FCM).
--
-- ADDITIVE + backward-compatible. Nothing existing changes shape:
--   * push_deliveries (new)    — one row per (source event, device) push attempt.
--   * worker_devices.push_target (new, nullable) — opaque per-install nonce echoed in
--     the payload so a client can DROP a push that is not for its live session. An FCM
--     token addresses an app INSTALL, not a person, so on a shared/handed-down handset
--     it can move between workers; without this the client cannot tell.
--   * worker_devices_push_token_idx (new, partial) — supports "steal-on-register":
--     registering a token nulls that same token on every OTHER row holding it.
--
-- ROLLBACK (safe — the feature ships behind PUSH_ENABLE_REAL=false and writes nothing
-- until it is armed):
--   DROP INDEX "worker_devices_push_token_idx";
--   ALTER TABLE "worker_devices" DROP COLUMN "push_target";
--   DROP TABLE "push_deliveries";
--
-- ERASURE (ADR-0031): push_deliveries.device_id CASCADES from worker_devices, which
-- cascades from workers — so workers -> worker_devices -> push_deliveries erases in one
-- DELETE with no new leg in AccountDeletionService. event_id is SET NULL on purpose:
-- the audit spine is PII-free and outlives the worker.
CREATE TABLE "push_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid,
	"device_id" uuid NOT NULL,
	"status" text NOT NULL,
	"failure_reason" text,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_deliveries_status_chk" CHECK ("push_deliveries"."status" IN ('sent', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "push_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_devices" ADD COLUMN "push_target" uuid;--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_device_id_worker_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."worker_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "push_deliveries_event_device_uq" ON "push_deliveries" USING btree ("event_id","device_id");--> statement-breakpoint
CREATE INDEX "push_deliveries_device_id_idx" ON "push_deliveries" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "worker_devices_push_token_idx" ON "worker_devices" USING btree ("push_token") WHERE "worker_devices"."push_token" IS NOT NULL;--> statement-breakpoint
-- Spine posture (ADR-0004), identical to worker_devices in 0029: drizzle emits only
-- ENABLE, so FORCE + REVOKE ALL are carried here. No policies exist, so with FORCE the
-- table is deny-by-default for every client-facing role; the backend reaches it with
-- the service-role connection, and WorkerAuthGuard is the app-layer control.
ALTER TABLE "push_deliveries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "push_deliveries" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "push_deliveries" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "push_deliveries" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "push_deliveries" FROM service_role;