-- ==============================================================================
-- 0117 - profile_correction: the audit fact that a worker corrected an extracted field
-- ==============================================================================
--
-- #1311 backend half (per-field extracted-correction contract). One row per corrected
-- field per profile: WHOSE profile, WHICH interview it anchors to, WHICH extracted
-- fact moved, WHEN. The corrected VALUES live in the authored stores (never here):
--
--   skills       → worker_profile_skill (source 'worker_confirmed') + worker_profiles.skills
--   machines     → worker_profiles.machines
--   experience   → worker_profiles.experience.total_years
--   education    → worker_education rows (via the qualifications writer)
--   certificates → worker_certificate rows (via the qualifications writer)
--
-- NO VALUES ON THIS ROW, by the same rule the `resume.edited` event obeys (ids + closed
-- enum only): a second copy of a corrected list is a second source for the sheet to
-- disagree with. The row is the cap counter (MAX_CORRECTIONS_PER_PROFILE mirrors
-- MAX_CORRECTIONS_PER_SESSION) and the `resume.edited` correlation id
-- (`correction_id`); the stores are the values.
--
-- `session_id` is an OPAQUE ANCHOR, not an FK — the pinned interview this correction was
-- validated against (Defect-A option a: occupation pins and close-pinned universal
-- pointers alike). No FK, like `worker_profile_skill.evidence_ref`: chat_sessions lifecycle
-- (DSAR sweeps) must never be coupled to the audit fact, and erasure is complete through
-- the profile cascade below.
--
-- `pc_field_chk` is CLOSED (`skills|machines|experience|education|certificates`) — the
-- same five the contract and the event enum carry, so a sixth field needs all three
-- changed together, deliberately.
--
-- ADDITIVE / BACKWARD-COMPATIBLE. One new, empty table; no shipped column moves; a
-- profile with no rows confirms and generates exactly as before. Rollback is one
-- statement:
--
--   DROP TABLE "profile_correction";
--
-- APPLY-BEFORE-DEPLOY: `ProfileCorrectionsRepository` names the table unconditionally on
-- POST /profile/corrections, so the route 500s (relation does not exist) against a
-- database without it. Registered as `0117-profile-correction-table` +
-- `0117-profile-correction-rls` in `schema-contract.ts`; listed in `LOCKED_TABLES` in
-- the e2e RLS spine.
-- ==============================================================================
CREATE TABLE "profile_correction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"field" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pc_field_chk" CHECK ("profile_correction"."field" IN ('skills','machines','experience','education','certificates'))
);
--> statement-breakpoint
ALTER TABLE "profile_correction" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profile_correction" ADD CONSTRAINT "profile_correction_profile_id_worker_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."worker_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pc_profile_idx" ON "profile_correction" USING btree ("profile_id");--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
--
-- The same posture every worker-data table since 0071 carries: nothing reaches these
-- rows except the API's BYPASSRLS connection. FORCE matters because it applies to the
-- table OWNER too. `drizzle-kit generate` emits only the ENABLE above; FORCE and the
-- four REVOKEs are hand-written, and a regenerate drops them silently - the second
-- reason this file must not be regenerated blindly.
-- ===========================================================================
ALTER TABLE "profile_correction" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "profile_correction" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "profile_correction" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "profile_correction" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "profile_correction" FROM service_role;
