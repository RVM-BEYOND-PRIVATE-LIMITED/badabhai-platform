-- B4 ATTRIBUTION — the resolver primitive: `referral_links` + `referral_clicks`.
--
-- EXPAND-ONLY: two NEW tables. Nothing existing is touched — no column dropped, no
-- constraint altered, no data rewritten. Safe to apply while the app is serving.
--
-- WHY. Referral attribution does not survive the Play Store round-trip, so the
-- commission channel cannot be measured or paid reliably. The two halves that were
-- missing are (a) a single primitive that every agent code / worker share / campaign
-- URL / QR resolves through, and (b) a per-click TIMESTAMP, without which "was this
-- click inside the match window?" has no answer. `invites` (ADR-0020) and
-- `agency_invites` (ADR-0022) provide neither: they model who-invited-whom, carry a
-- status enum and a mutable `updated_at` that a later click overwrites, and cannot
-- express a campaign link or deep-link context.
--
-- THESE TABLES DO NOT REPLACE EITHER FUNNEL. `GET /r/:code` resolves `referral_links`
-- first and FALLS THROUGH to both legacy code spaces, logging the click either way —
-- so links shared before this migration keep working and are covered by the window
-- rule too. One resolver, one click log, one place to audit.
--
-- ── referral_links ──────────────────────────────────────────────────────────
-- One row per shareable link. `kind` says who owns it (agent / worker / campaign);
-- `medium` ('organic' | 'paid') is the MATCH-WINDOW DISCRIMINATOR, stamped here and
-- snapshotted onto every click so a later re-tag cannot retroactively re-judge a past
-- click. The window LENGTHS are config (REFERRAL_MATCH_WINDOW_ORGANIC_HOURS /
-- _PAID_HOURS), never literals — they are expected to be tuned post-launch.
--
-- `referral_links_single_owner_chk` forbids a row that has BOTH an agent and a worker
-- owner: "who gets the commission" must never be ambiguous, and that is precisely what
-- this table exists to make unambiguous. A pure campaign link has neither.
--
-- THE CODE IS A BEARER TOKEN — anyone holding it can claim the referral. It is never
-- put in an event payload, a log line, or any response body beyond the resolver's own
-- redirect. Events carry `referral_link_id`. (The same rule `invite.clicked` and
-- `InviteInstallPayload` have followed since ADR-0020.)
--
-- PII-FREE (invariant #2): opaque UUIDs, an opaque short code, closed enums, and a
-- `payload` JSONB contract-bound to NON-PII deep-link context (role slug, city slug,
-- campaign tag) — the discipline `invites.campaign` has held since ADR-0020. No phone,
-- no name, no employer, ever.
--
-- ── referral_clicks ─────────────────────────────────────────────────────────
-- The click log, and the row a first-touch claim locks.
--
-- `referral_clicks_claimed_worker_uq` IS THE FIRST-TOUCH RULE'S TEETH: a PARTIAL
-- UNIQUE index on `claimed_by_worker_id` — one claimed click per worker, EVER. Two
-- concurrent install-referrer posts for the same worker could previously resolve two
-- claims; now the loser hits a unique violation and is neutralised into a no-op. The
-- `SELECT … FOR UPDATE` in the claim transaction is the other half, but THIS is the
-- half that actually holds: a row lock alone cannot stop two transactions that pick
-- two DIFFERENT candidate rows, which is exactly what clicks on two different links
-- produce. Partial because unclaimed rows are the overwhelming majority and must not
-- contend on the index.
--
-- EQUIVALENCE TO A PHONE-HASH KEY (deliberate, and the reason no phone hash is added
-- here): the growth playbook words this rule as "unique on the phone hash + active
-- window". `workers.phone_hash` is ALREADY UNIQUE, so one worker id IS one phone —
-- keying on `claimed_by_worker_id` enforces the identical rule without copying a
-- phone-derived hash into a second table, which would widen the PII surface for no
-- gain (invariant #2). Claims resolve post-auth, so the worker id is always known.
--
-- `click_hash` is a keyed HMAC-SHA256 over (ip + user-agent) — the same idiom as
-- `workers.phone_hash` / `worker_devices.device_hash`. The RAW ip and user-agent are
-- NEVER persisted, logged, or evented. It exists only to de-duplicate refresh spam.
--
-- DPDP ERASURE: `claimed_by_worker_id` and `referral_links.owner_worker_id` are ON
-- DELETE SET NULL — a worker hard-delete (DSAR) nulls the identity join and PRESERVES
-- the PII-free attribution row (the ADR-0026 Phase 5 D3 posture `invites` already
-- uses). `referral_links.agent_payer_id` CASCADES, mirroring
-- `agency_invites.inviter_payer_id`: a payer is an internal tenant entity, and its
-- links have no meaning once the tenant is gone.
--
-- ⚠️ STRUCTURE ONLY — creating these tables pays nobody. Commission payout stays
-- behind AGENCY_PAYOUTS_ENABLED (ADR-0022 Amendment 2) and real money remains a
-- human-gated escalation (CLAUDE.md §7). This lands the measurement spine only.
--
-- LOCKS: CREATE TABLE + CREATE INDEX on two brand-new (therefore empty) tables. No
-- lock is taken on any live table. The FKs to `workers`/`payers` take a brief
-- SHARE ROW EXCLUSIVE on those parents to validate the reference, which is the normal
-- cost of any new FK and is instantaneous against an empty child.
--
-- ROLLBACK (fully reversible while both tables are empty, which they are on arrival —
-- no writer exists until the B4 resolver ships):
--   DROP TABLE "referral_clicks";
--   DROP TABLE "referral_links";
--
-- Registered in tests/e2e/rls-spine.e2e.test.ts LOCKED_TABLES.
CREATE TABLE "referral_clicks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referral_link_id" uuid,
	"code" text NOT NULL,
	"click_hash" text NOT NULL,
	"medium" text DEFAULT 'organic' NOT NULL,
	"platform" text DEFAULT 'other' NOT NULL,
	"clicked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_by_worker_id" uuid,
	"claimed_at" timestamp with time zone,
	CONSTRAINT "referral_clicks_medium_chk" CHECK ("referral_clicks"."medium" IN ('organic', 'paid')),
	CONSTRAINT "referral_clicks_claim_pair_chk" CHECK (("referral_clicks"."claimed_by_worker_id" IS NULL) = ("referral_clicks"."claimed_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "referral_clicks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "referral_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"kind" text NOT NULL,
	"medium" text DEFAULT 'organic' NOT NULL,
	"agent_payer_id" uuid,
	"owner_worker_id" uuid,
	"campaign_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "referral_links_single_owner_chk" CHECK (NOT ("referral_links"."agent_payer_id" IS NOT NULL AND "referral_links"."owner_worker_id" IS NOT NULL)),
	CONSTRAINT "referral_links_kind_chk" CHECK ("referral_links"."kind" IN ('agent', 'worker', 'campaign')),
	CONSTRAINT "referral_links_medium_chk" CHECK ("referral_links"."medium" IN ('organic', 'paid'))
);
--> statement-breakpoint
ALTER TABLE "referral_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "referral_clicks" ADD CONSTRAINT "referral_clicks_referral_link_id_referral_links_id_fk" FOREIGN KEY ("referral_link_id") REFERENCES "public"."referral_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_clicks" ADD CONSTRAINT "referral_clicks_claimed_by_worker_id_workers_id_fk" FOREIGN KEY ("claimed_by_worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_links" ADD CONSTRAINT "referral_links_agent_payer_id_payers_id_fk" FOREIGN KEY ("agent_payer_id") REFERENCES "public"."payers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_links" ADD CONSTRAINT "referral_links_owner_worker_id_workers_id_fk" FOREIGN KEY ("owner_worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_clicks_claimed_worker_uq" ON "referral_clicks" USING btree ("claimed_by_worker_id") WHERE "referral_clicks"."claimed_by_worker_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "referral_clicks_code_clicked_idx" ON "referral_clicks" USING btree ("code","clicked_at");--> statement-breakpoint
CREATE INDEX "referral_clicks_hash_idx" ON "referral_clicks" USING btree ("click_hash","clicked_at");--> statement-breakpoint
CREATE INDEX "referral_clicks_link_idx" ON "referral_clicks" USING btree ("referral_link_id");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_links_code_uq" ON "referral_links" USING btree ("code");--> statement-breakpoint
CREATE INDEX "referral_links_agent_payer_id_idx" ON "referral_links" USING btree ("agent_payer_id");--> statement-breakpoint
CREATE INDEX "referral_links_owner_worker_id_idx" ON "referral_links" USING btree ("owner_worker_id");--> statement-breakpoint
CREATE INDEX "referral_links_campaign_idx" ON "referral_links" USING btree ("campaign_id") WHERE "referral_links"."campaign_id" IS NOT NULL;--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- Spine posture (ADR-0004 / TD20): FORCE RLS + REVOKE ALL for every Data-API role.
-- drizzle-kit emits ENABLE only (above). Registered in
-- tests/e2e/rls-spine.e2e.test.ts LOCKED_TABLES.
--
-- These two tables hold referral BEARER TOKENS and a worker-attribution handle, so
-- neither may ever be reachable from an anon/authenticated PostgREST session — a
-- client that could read `referral_links.code` could claim any agent's commission.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "referral_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "referral_links" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "referral_links" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "referral_links" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "referral_links" FROM service_role;--> statement-breakpoint
ALTER TABLE "referral_clicks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "referral_clicks" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "referral_clicks" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "referral_clicks" FROM authenticated;--> statement-breakpoint
REVOKE ALL ON TABLE "referral_clicks" FROM service_role;
