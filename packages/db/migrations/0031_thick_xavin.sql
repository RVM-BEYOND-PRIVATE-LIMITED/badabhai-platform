-- ADR-0026 Phase 5 — DPDP account deletion: billing/intent FKs cascade → SET NULL.
-- §7 ESCALATION (billing-FK semantic change): preserves the PII-free unlock/disclosure/
-- referral row (nulls the worker join) instead of destroying it on a worker erasure —
-- mirrors the existing agency_invites/invites.invited_worker_id DSAR posture. Additive +
-- backward-compatible: existing rows keep their non-null worker_id; SET NULL fires only on a
-- future worker DELETE; widening to nullable never invalidates existing data.
-- HUMAN SIGN-OFF (Prakash/Akshit) REQUIRED before any remote/Supabase apply.
-- ROLLBACK: re-add NOT NULL (PRE-CONDITION: no row may hold a NULL worker_id/inviter_worker_id
--   at rollback time) + restore ON DELETE CASCADE on the three constraints below.
ALTER TABLE "invites" DROP CONSTRAINT "invites_inviter_worker_id_workers_id_fk";
--> statement-breakpoint
ALTER TABLE "resume_disclosures" DROP CONSTRAINT "resume_disclosures_worker_id_workers_id_fk";
--> statement-breakpoint
ALTER TABLE "unlocks" DROP CONSTRAINT "unlocks_worker_id_workers_id_fk";
--> statement-breakpoint
ALTER TABLE "invites" ALTER COLUMN "inviter_worker_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "resume_disclosures" ALTER COLUMN "worker_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "unlocks" ALTER COLUMN "worker_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_inviter_worker_id_workers_id_fk" FOREIGN KEY ("inviter_worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_disclosures" ADD CONSTRAINT "resume_disclosures_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unlocks" ADD CONSTRAINT "unlocks_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;