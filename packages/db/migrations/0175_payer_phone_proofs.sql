-- ==============================================================================
-- payer_phone_proofs: a company proved the phone on its account (#2754 item 3)
-- ==============================================================================
--
-- (The header and the RLS tail below are HAND-WRITTEN and carry no migration number of their
-- own, so a regenerate under another slot keeps them word for word: re-prepend this header,
-- re-append the tail.)
--
-- #2754 item 3, "one account per phone before the move". A company's phone is a SIGN-IN
-- CREDENTIAL (an SMS code may sign it in, behind PAYER_SMS_OTP_ENABLED) only while a row here
-- holds that account's CURRENT `payers.phone_hash`. A phone typed at sign-up or in
-- `PATCH /payer/me` is stored unproven; the signed-in company proves it by entering a code sent
-- to it (`POST /payer/me/phone-proof` then `/verify`, method `sms_code`). An imported Campus
-- company may bring Campus's own OTP-verified sign-in phone (method `campus_import`; no caller
-- yet, #2754 item 6).
--
-- ONE ACCOUNT PER PROVEN PHONE. `payer_phone_proofs_phone_hash_uq` (unique on phone_hash) lets
-- only one account ever hold the proof of a phone, so SMS sign-in can never land in the wrong
-- account, without refusing a sign-up or touching an existing duplicate phone. The rule is on
-- the PROOF, not on `payers.phone_hash`: production may already hold duplicates, and a unique
-- index on payers would fail to apply (and block every later migration). That payers-level
-- index stays an owner step for after the duplicates are resolved by hand (the read-only
-- `pnpm --filter @badabhai/api report:shared-payer-phones` lists them, ids only).
--
-- A PHONE CHANGE DROPS THE PROOF, in the same transaction as the change
-- (`PayersRepository.update`). Archive and suspend leave it; the sign-in status checks refuse
-- those accounts. `payer_id` (the PRIMARY KEY, so indexed) cascades on the account's hard delete.
--
-- IDS, A KEYED HASH, A CLOSED CODE AND A TIME: never the number. The hash is `hashPhone`, the
-- same keyed HMAC as `payers.phone_hash`. `payer_phone_proofs_method_chk` is the closed method set.
--
-- ADDITIVE ONLY. One new, empty table; no existing column, constraint or row moves. Nothing is
-- backfilled: every phone starts unproven.
--
-- DEPLOY ORDER - APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY. Every read of this table fails
-- CLOSED on 42P01: with the table missing no phone counts as proven, so an SMS sign-in sends
-- nothing (the same neutral body), the two proof routes answer 503, and a phone change in
-- `PATCH /payer/me` still succeeds (its proof drop runs in a savepoint that tolerates the missing
-- table). Apply every lower-numbered migration first (slot order), then this, then arm
-- PAYER_SMS_OTP_ENABLED.
--
-- LOCKS. CREATE TABLE is instant, but the FOREIGN KEY takes SHARE ROW EXCLUSIVE on `payers`,
-- which blocks every payer write (sign-in stamps, profile edits) while it waits behind a long
-- transaction. Apply by hand in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` and
-- retry on 55P03 (the 0129 / 0130 / 0166 / 0167 / 0170 / 0171 / 0172 / 0173 precedent).
--
-- RLS: ENABLE is generated; FORCE and the four REVOKEs at the end are HAND-WRITTEN (the
-- 0117 / 0156 / 0160 / 0161 / 0167 / 0170 / 0171 / 0172 / 0173 pattern) - a regenerate drops
-- them silently. Registered as an `rls` entry in `schema-contract.ts`; listed in LOCKED_TABLES
-- in the e2e RLS spine.
--
-- ROLLBACK (switch PAYER_SMS_OTP_ENABLED off and redeploy first; every proof is lost, and each
-- company proves its phone again after a re-apply):
--   DROP TABLE "payer_phone_proofs";
-- and delete this migration's row from drizzle.__drizzle_migrations (the one whose created_at
-- is this entry's journal `when`).
--
-- SAFE TO RE-RUN: no (plain CREATE TABLE). Apply once.
-- ==============================================================================
CREATE TABLE "payer_phone_proofs" (
	"payer_id" uuid PRIMARY KEY NOT NULL,
	"phone_hash" text NOT NULL,
	"method" text NOT NULL,
	"proven_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payer_phone_proofs_method_chk" CHECK ("payer_phone_proofs"."method" IN ('sms_code', 'campus_import'))
);
--> statement-breakpoint
ALTER TABLE "payer_phone_proofs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payer_phone_proofs" ADD CONSTRAINT "payer_phone_proofs_payer_id_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payer_phone_proofs_phone_hash_uq" ON "payer_phone_proofs" USING btree ("phone_hash");
--> statement-breakpoint
-- ===========================================================================
-- DENY BY DEFAULT - RLS forced, every role revoked, and NO POLICY.
-- `drizzle-kit generate` emits only the ENABLE above; FORCE and the four REVOKEs are
-- HAND-WRITTEN (the 0117 / 0156 / 0160 / 0161 / 0167 pattern), because a regenerate drops them.
-- ===========================================================================
ALTER TABLE "payer_phone_proofs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_phone_proofs" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_phone_proofs" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_phone_proofs" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "payer_phone_proofs" FROM service_role;
