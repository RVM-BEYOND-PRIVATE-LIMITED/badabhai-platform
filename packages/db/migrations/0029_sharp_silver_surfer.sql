CREATE TABLE "worker_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"pin_hash" text NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"lockout_cycles" integer DEFAULT 0 NOT NULL,
	"pin_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "worker_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "worker_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"device_hash" text NOT NULL,
	"platform" text DEFAULT 'unknown' NOT NULL,
	"model" text,
	"app_version" text,
	"push_token" text,
	"attestation_verified" boolean DEFAULT false NOT NULL,
	"trusted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_devices_platform_chk" CHECK ("worker_devices"."platform" IN ('android', 'ios', 'web', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "worker_devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "worker_credentials" ADD CONSTRAINT "worker_credentials_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_devices" ADD CONSTRAINT "worker_devices_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "worker_credentials_worker_id_uq" ON "worker_credentials" USING btree ("worker_id");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_devices_worker_device_uq" ON "worker_devices" USING btree ("worker_id","device_hash");--> statement-breakpoint
CREATE INDEX "worker_devices_worker_id_idx" ON "worker_devices" USING btree ("worker_id");--> statement-breakpoint
-- Spine posture (ADR-0004 / ADR-0026): FORCE RLS + REVOKE all Data-API roles on both
-- new identity-cluster tables. worker_credentials holds the device-unlock PIN hash (a
-- secret-derived credential) + throttle state; worker_devices holds the device-binding
-- registry (HMAC + push token). Both are locked at least as tightly as workers/payers/
-- admin_users: anon/authenticated/service_role are denied outright (drizzle-kit emits
-- ENABLE only; FORCE + REVOKE appended here, mirroring 0026/0009/0016/0023/0025). Only
-- the backend postgres/BYPASSRLS role reaches them; the WorkerAuthGuard + the server-side
-- PIN throttle are the app-layer controls.
-- ROLLBACK (safe — purely additive, nothing references these tables):
--   DROP TABLE "worker_credentials"; DROP TABLE "worker_devices";
ALTER TABLE "worker_credentials" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_credentials" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_credentials" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_credentials" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_credentials" FROM service_role;--> statement-breakpoint
ALTER TABLE "worker_devices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_devices" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_devices" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_devices" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "worker_devices" FROM service_role;