/**
 * Referral / agency domain — the invite funnels (worker + agency), agency KYC and
 * payouts, the referral-link resolver primitive with its click log, and worker
 * referral bonus accruals.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { workers } from "./worker";
import { payers, unlocks } from "./payer";

// ---------------------------------------------------------------------------
// invites — WhatsApp invite/referral funnel (ADR-0020). PII-FREE.
//
// An invite is a shareable deep-link (`/i/<code>`). The `code` is an opaque
// token; `inviter_worker_id` / `invited_worker_id` are opaque worker UUIDs — NO
// phone, NO name, NO message body ever lands here (the phone touches the WhatsApp
// provider only, at send time). This is the upstream attribution signal the
// deferred agency-referral payout will consume. RLS-enabled (REVOKE in the
// migration, spine posture). `invited_worker_id` is set on signup-acceptance.
//
// DPDP erasure posture (ADR-0026 Phase 5, D3): BOTH `inviter_worker_id` and
// `invited_worker_id` are `onDelete: "set null"` + NULLABLE — a worker hard-delete
// (DSAR) PRESERVES this PII-free referral-attribution row and only nulls the
// identity join(s). `inviter_worker_id` was changed cascade→set-null here so an
// inviter's erasure no longer DESTROYS referral history; it now matches the
// already-correct `invited_worker_id` "keep INTENT history intact" posture.
// Existing rows keep their (non-null) inviter_worker_id; SET NULL fires only on a
// future worker DELETE.
// ---------------------------------------------------------------------------
export type InviteChannel = "whatsapp";
export type InviteStatus = "created" | "clicked" | "accepted";

export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The opaque deep-link token (the only thing shared). Unique.
    code: text("code").notNull(),
    // NULLABLE + onDelete:"set null" — DSAR erasure nulls the join, keeps the
    // PII-free referral-attribution row (ADR-0026 Phase 5 D3).
    inviterWorkerId: uuid("inviter_worker_id").references(() => workers.id, {
      onDelete: "set null",
    }),
    // Set when an invited person becomes a worker (attribution). Nullable until then.
    invitedWorkerId: uuid("invited_worker_id").references(() => workers.id, {
      onDelete: "set null",
    }),
    channel: text("channel").$type<InviteChannel>().notNull().default("whatsapp"),
    status: text("status").$type<InviteStatus>().notNull().default("created"),
    // Optional non-PII campaign tag (a stable code, never free-form PII).
    campaign: text("campaign"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("invites_code_uq").on(t.code),
    index("invites_inviter_worker_id_idx").on(t.inviterWorkerId),
  ],
).enableRLS(); // RLS tracked in the model; REVOKE carried by the migration (spine posture)

// ---------------------------------------------------------------------------
// agency_invites — AGENCY supply-attribution INTENT (ADR-0022). FACELESS, ids-only.
//
// The SIBLING of `invites` (the worker→worker funnel above). A distinct table — NOT
// a reuse — because `invites.inviter_worker_id` is `NOT NULL → workers`, while here
// the inviter is a PAYER (the agency, `payers.role = 'agent'`): a different principal
// on a different identity axis. Forcing both funnels through one table would have
// meant a nullable worker FK + a payer FK + a discriminator on every row — strictly
// worse than two purpose-built tables (ADR-0022, ACCEPTED).
//
// An agency invite is a shareable deep-link (`/i/<code>`). The `code` is an opaque
// token (the only thing shared); NO phone, NO name, NO email, NO message body ever
// lands here — the worker's contact touches the WhatsApp provider only, at send time.
// `invited_worker_id` is the attribution handle, set ONLY after the invited person
// becomes a worker with `consent.accepted` (DPDP gate, invariant #6).
//
// FACELESS / ids-only by construction: ABSOLUTELY NO KYC / bank / PAN / GST / payout /
// commission / money / amount column ever (the deferred agency-payout rails consume
// this as an upstream signal; they do NOT live here). The only references are opaque
// UUIDs (`inviter_payer_id`, `invited_worker_id`) + enums + a stable non-PII campaign
// tag — exactly the `invites` discipline.
//
// SECURITY (ADR-0022 Appendix C #3): `invited_worker_id` is a NEW payer-side handle
// onto a worker, so this table ships the full spine lock — ENABLE + FORCE ROW LEVEL
// SECURITY + REVOKE ALL from PUBLIC/anon/authenticated/service_role (carried by the
// migration). Phase-1 isolation is the APP-LAYER chokepoint (`assertPayerOwns` on
// `inviter_payer_id`); DB-enforced per-payer RLS is the open-GA launch gate, like the
// rest of the payer-owned spine (rls-plan.md).
// ---------------------------------------------------------------------------
export type AgencyInviteChannel = InviteChannel; // mirror the invite channel enum ('whatsapp')
export type AgencyInviteStatus = InviteStatus; // 'created' | 'clicked' | 'accepted'
// The SAME closed pair as `referral_links.medium`, aliased rather than re-declared so the
// two code spaces cannot drift into different sets by the same name (the DB CHECKs are
// likewise byte-identical). 'organic' | 'paid'.
export type AgencyInviteMedium = ReferralLinkMedium;

export const agencyInvites = pgTable(
  "agency_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The agency that owns this invite (a `payers` row with role='agent'). FK to
    // payers(id): an INTERNAL tenant entity, NOT worker PII, so a real FK + cascade
    // is appropriate and keeps referential integrity. `payer_id` is the only token
    // for the agency — its B2B contact PII stays in `payers`, never copied here.
    inviterPayerId: uuid("inviter_payer_id")
      .notNull()
      .references(() => payers.id, { onDelete: "cascade" }),
    // The opaque deep-link token (the only thing shared). Unique.
    code: text("code").notNull(),
    // Attribution handle: set ONLY after the invited person becomes a worker with
    // consent.accepted (invariant #6). Nullable until then. FK to workers(id) with
    // ON DELETE SET NULL — mirrors `invites.invited_worker_id`: the FK preserves
    // referential integrity (no dangling worker id), and SET NULL keeps the
    // attribution row's INTENT history intact when a worker is hard-deleted (DSAR).
    // The table's FORCE-RLS + REVOKE lock is what keeps this payer→worker handle
    // app-layer-only, satisfying ADR-0022 Appendix C #3.
    invitedWorkerId: uuid("invited_worker_id").references(() => workers.id, {
      onDelete: "set null",
    }),
    channel: text("channel").$type<AgencyInviteChannel>().notNull().default("whatsapp"),
    status: text("status").$type<AgencyInviteStatus>().notNull().default("created"),
    // Optional non-PII campaign tag (a stable code, never free-form PII) — mirrors
    // the `invites.campaign` rule.
    campaign: text("campaign"),
    // ── Link metadata (W1) ──────────────────────────────────────────────────
    // The MATCH-WINDOW DISCRIMINATOR, same closed enum and same CHECK shape as
    // `referral_links.medium` — deliberately identical so the two code spaces
    // cannot drift into meaning different things by the same name. `organic` is
    // the default because an agency link shared hand-to-hand IS organic; `paid`
    // is opt-in and shortens the attribution window (see
    // REFERRAL_MATCH_WINDOW_PAID_HOURS).
    medium: text("medium").$type<ReferralLinkMedium>().notNull().default("organic"),
    // CONTEXTUAL DEEP-LINK DATA ONLY — the same contract as
    // `referral_links.payload`, but CLOSED rather than loose: the API layer
    // (`InviteContextSchema`) admits exactly `role` and `city`, each a bounded
    // lowercase slug run through `looksLikeActionContextPii`. A jsonb column on
    // an agency-writable endpoint is the widest PII surface this table has, so
    // the shape is pinned at the boundary and the column stays additive.
    // NEVER a phone, a name, an employer, or free-form text (invariant #2).
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    // The 90-day attribution-window anchor for the payout ledger (ADR-0022 Amendment 2).
    // Set ONCE at markAccepted, alongside invited_worker_id. Additive + nullable
    // (invariant #8): rows accepted before this column existed stay null and are excluded
    // from accrual until re-set. PII-FREE (a timestamp). Never leaves this row raw.
    attributedAt: timestamp("attributed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agency_invites_code_uq").on(t.code),
    // Owner-scoped reads (the agency's own invites — the assertPayerOwns hot path).
    index("agency_invites_inviter_payer_id_idx").on(t.inviterPayerId),
    // Reverse lookup: which invite attributed a given worker (set-once, sparse).
    index("agency_invites_invited_worker_id_idx").on(t.invitedWorkerId),
    // Same closed set as `referral_links_medium_chk`. Enforced in the DB and not
    // only in zod, because the match-window arithmetic downstream branches on
    // this value — a third value would silently fall through to the organic
    // window rather than fail.
    check("agency_invites_medium_chk", sql`${t.medium} IN ('organic', 'paid')`),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by the migration (spine posture)

// ---------------------------------------------------------------------------
// agency_kyc — AGENCY financial KYC (PAN + bank), ADR-0022 module 1 (LEGAL_MONEY_GATE),
// built MOCK + launch-gated (AGENCY_PAYOUTS_ENABLED default OFF), owner-ratified 2026-07-23
// (ADR-0022 Amendment 2). HIGH-SENSITIVITY FINANCIAL PII AT REST — same ADR-0004 discipline
// as `workers`/`payers`: AES-256-GCM ciphertext + keyed HMAC lookup, FORCE-RLS + REVOKE
// (migration), backend-service-role only. These fields NEVER reach events / ai_jobs /
// audit_logs / logs / LLM input — only the opaque `payer_id` + `status` enum ever leave this
// row (masked last-4 to the owning agency, never full PAN/bank). One KYC row per agency.
// Real-registry verification + live collection remain the legal/DPDP + §7 launch gates
// (nothing is checked against a real registry here — ops "verify" is a mock human ack).
// ---------------------------------------------------------------------------
export type AgencyKycStatus = "pending" | "verified" | "rejected";
export const agencyKyc = pgTable(
  "agency_kyc",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The owning agency (payers.role='agent'). One KYC row per agency.
    payerId: uuid("payer_id")
      .notNull()
      .references(() => payers.id, { onDelete: "cascade" }),
    // PAN: AES ciphertext at rest + keyed HMAC (dedup — one PAN cannot back many agencies).
    panEnc: text("pan_enc").notNull(),
    panHash: text("pan_hash").notNull(),
    // Bank payout details — ciphertext at rest (no lookup hash needed).
    bankAccountEnc: text("bank_account_enc").notNull(),
    ifscEnc: text("ifsc_enc").notNull(),
    accountHolderNameEnc: text("account_holder_name_enc").notNull(),
    status: text("status").$type<AgencyKycStatus>().notNull().default("pending"),
    // Ops verification audit (mock human ack; NO real registry check in alpha).
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedBy: uuid("verified_by"),
    rejectReason: text("reject_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agency_kyc_payer_id_uq").on(t.payerId),
    uniqueIndex("agency_kyc_pan_hash_uq").on(t.panHash),
    // reject_reason is only valid on a reject (NULL otherwise).
    check("agency_kyc_reject_reason_chk", sql`${t.rejectReason} IS NULL OR ${t.status} = 'rejected'`),
  ],
).enableRLS(); // FORCE + REVOKE carried by the migration (financial-PII spine posture, ADR-0004)
export type AgencyKyc = typeof agencyKyc.$inferSelect;
export type NewAgencyKyc = typeof agencyKyc.$inferInsert;

// ---------------------------------------------------------------------------
// agency_payout_requests — MOCK payout requests (ADR-0022 module 7, Amendment 2). PII-FREE:
// ₹ + ids + enum only. A request claims the agency's currently-unpaid accruals (₹ sum) once
// the KYC gate (status='verified') AND the ₹500 minimum threshold both pass. `status='paid'`
// is INERT — no real disbursement in alpha (PAYMENTS_ENABLE_REAL=false; real outbound money
// is the §7 launch gate). Exactly-once via UNIQUE(idempotency_key). RLS-locked (spine posture).
// ---------------------------------------------------------------------------
export type AgencyPayoutRequestStatus = "requested" | "paid" | "rejected";
export const agencyPayoutRequests = pgTable(
  "agency_payout_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agencyPayerId: uuid("agency_payer_id")
      .notNull()
      .references(() => payers.id, { onDelete: "cascade" }),
    amountInr: integer("amount_inr").notNull(),
    accrualCount: integer("accrual_count").notNull(),
    status: text("status").$type<AgencyPayoutRequestStatus>().notNull().default("requested"),
    // The KYC status snapshot at request time (audit — must have been 'verified' to pass).
    kycSnapshotStatus: text("kyc_snapshot_status").$type<AgencyKycStatus>().notNull(),
    // Exactly-once guard (mirrors credit_ledger.idempotency_key). Opaque; NO PII/value.
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("agency_payout_requests_agency_payer_id_idx").on(t.agencyPayerId),
    uniqueIndex("agency_payout_requests_idempotency_key_uq").on(t.idempotencyKey),
    check("agency_payout_requests_amount_nonneg_chk", sql`${t.amountInr} >= 0`),
  ],
).enableRLS();
export type AgencyPayoutRequest = typeof agencyPayoutRequests.$inferSelect;
export type NewAgencyPayoutRequest = typeof agencyPayoutRequests.$inferInsert;

// ---------------------------------------------------------------------------
// agency_payout_accruals — APPEND-ONLY commission accrual ledger (ADR-0022 modules 3+7,
// Amendment 2). PII-FREE: ₹ amounts + opaque ids only. One accrual per granted unlock on a
// worker the agency referred, within the 90-day attribution window; amount = a STAMPED basis
// × rate (owner-ratified 25% × ₹40 = ₹10). Basis/rate are stamped per row so a later config
// change never rewrites history (mirrors credit_ledger.price_inr). Idempotent by
// UNIQUE(source_unlock_id). MOCK — a computed accrual, no real money. RLS-locked (spine
// posture): source_unlock_id is one hop from a worker, so it is never returned raw — only
// aggregate earnings leave the API.
// ---------------------------------------------------------------------------
export const agencyPayoutAccruals = pgTable(
  "agency_payout_accruals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agencyPayerId: uuid("agency_payer_id")
      .notNull()
      .references(() => payers.id, { onDelete: "cascade" }),
    // The granted unlock that generated this accrual. UNIQUE → exactly-once per unlock.
    sourceUnlockId: uuid("source_unlock_id")
      .notNull()
      .references(() => unlocks.id, { onDelete: "cascade" }),
    // Stamped economics (whole ₹ / basis points) so later config edits can't rewrite history.
    basisInr: integer("basis_inr").notNull(),
    rateBps: integer("rate_bps").notNull(),
    amountInr: integer("amount_inr").notNull(),
    // Real revenue-event time + the attribution window anchor (audit).
    unlockGrantedAt: timestamp("unlock_granted_at", { withTimezone: true }).notNull(),
    attributedAt: timestamp("attributed_at", { withTimezone: true }).notNull(),
    // Set when this accrual is claimed into a payout request (else unpaid/available).
    payoutRequestId: uuid("payout_request_id").references(() => agencyPayoutRequests.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agency_payout_accruals_source_unlock_id_uq").on(t.sourceUnlockId),
    index("agency_payout_accruals_agency_payer_id_idx").on(t.agencyPayerId),
    index("agency_payout_accruals_payout_request_id_idx").on(t.payoutRequestId),
    check("agency_payout_accruals_amount_nonneg_chk", sql`${t.amountInr} >= 0`),
  ],
).enableRLS();
export type AgencyPayoutAccrual = typeof agencyPayoutAccruals.$inferSelect;
export type NewAgencyPayoutAccrual = typeof agencyPayoutAccruals.$inferInsert;

// referral_bonus_accruals — one accrual per REFERRED worker, ever.
//
// THE FRAUD RULE HAS DB TEETH: UNIQUE(invited_worker_id). Not (inviter, invited) — that
// would let the same referred worker be claimed once by each of N inviters. One row per
// invited worker means a referred worker can generate exactly one bonus in the lifetime
// of that worker id, no matter who claims it or how many times the qualifying event
// replays.
//
// PII-FREE: two opaque worker UUIDs, an integer ₹ amount, a timestamp.
//
// DPDP ERASURE: BOTH worker FKs are ON DELETE CASCADE, so deleting EITHER party erases
// the accrual — no orphan pointing at a deleted worker. See the migration header for the
// two consequences that follow (a financial record is destroyed by the other party's
// erasure; and a delete+re-register mints a new worker id, so the "ever" is scoped to the
// id, not the person). Both are DPDP-correct and both are product-visible.
export const referralBonusAccruals = pgTable(
  "referral_bonus_accruals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    inviterWorkerId: uuid("inviter_worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    invitedWorkerId: uuid("invited_worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    // Whole ₹. Defaulted to the launch value but STAMPED per row, so a later change to
    // the bonus can never retroactively rewrite what a past referral was worth.
    amountInr: integer("amount_inr").notNull().default(20),
    // When the referral QUALIFIED (not when the invite was sent).
    qualifiedAt: timestamp("qualified_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The fraud rule (see header). ONE bonus per referred worker, ever.
    uniqueIndex("referral_bonus_accruals_invited_uq").on(t.invitedWorkerId),
    // "What has this worker earned?" — the inviter-side read, and the FK-referencing
    // column Postgres does not auto-index (the ON DELETE cascade needs it).
    index("referral_bonus_accruals_inviter_idx").on(t.inviterWorkerId),
    // A zero/negative bonus is a bug.
    check("referral_bonus_accruals_amount_pos_chk", sql`${t.amountInr} > 0`),
    // You cannot refer yourself.
    check(
      "referral_bonus_accruals_no_self_chk",
      sql`${t.inviterWorkerId} <> ${t.invitedWorkerId}`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0058

// ---------------------------------------------------------------------------
// referral_links — THE RESOLVER PRIMITIVE (B4). One row per shareable link.
//
// WHY A THIRD TABLE AND NOT A FOURTH CODE SPACE. `invites` (worker→worker,
// ADR-0020) and `agency_invites` (agency→worker, ADR-0022) each own an *actor*
// relationship: who invited whom. Neither can express a campaign link, a QR at a
// factory gate, or a link that carries deep-link CONTEXT (role/city) — and neither
// records WHEN a link was clicked, which is what a match window needs. This table
// is deliberately NOT a replacement for either: it is the SHARING/RESOLUTION layer
// that sits in front of both. `GET /r/:code` resolves here first and falls through
// to the two legacy code spaces, so there is ONE resolver, one click log, and one
// place to audit — the growth-tech playbook's "one primitive, one attribution path".
//
// THE CODE IS A BEARER TOKEN. Anyone holding it can claim the referral, so it is
// NEVER put in an event payload, a log line, or any response body beyond the
// resolver's own redirect (the same rule `invite.clicked` already follows — see
// InviteInstallPayload's header). Events carry `referral_link_id`, never `code`.
//
// PII-FREE (invariant #2): opaque UUIDs, a short opaque code, closed enums, and a
// `payload` JSONB that is CONTRACT-BOUND to non-PII deep-link context (role slug,
// city slug, campaign tag). No phone, no name, no employer — the same discipline
// `invites.campaign` has held since ADR-0020.
//
// DPDP erasure: `owner_worker_id` is `onDelete: "set null"` (keep the PII-free
// attribution row, drop the identity join — the ADR-0026 Phase 5 D3 posture that
// `invites` already uses). `agent_payer_id` cascades, mirroring
// `agency_invites.inviter_payer_id`: a payer is an internal tenant entity, not a
// worker, and its links have no meaning once the tenant is gone.
// ---------------------------------------------------------------------------

/** Who owns a link. Drives which legacy funnel (if any) an attribution belongs to. */
export type ReferralLinkKind = "agent" | "worker" | "campaign";

/**
 * ORGANIC vs PAID — the match-window discriminator, stamped on the LINK and
 * snapshotted onto every click. A share forwarded on WhatsApp ("organic") is
 * credited over a long window because the forward chain is slow; a paid click is
 * credited over a short one because ad networks bill on last-touch and a long
 * window would let a stale paid click steal an organic install. The two window
 * lengths are config, never literals (REFERRAL_MATCH_WINDOW_*_HOURS).
 */
export type ReferralLinkMedium = "organic" | "paid";

/** Coarse device class of a click. Diagnostics only — deliberately not a fingerprint. */
export type ReferralClickPlatform = "android" | "desktop" | "other";

export const referralLinks = pgTable(
  "referral_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The opaque short token that is actually shared (`/r/<code>`). Unique.
    code: text("code").notNull(),
    kind: text("kind").$type<ReferralLinkKind>().notNull(),
    medium: text("medium").$type<ReferralLinkMedium>().notNull().default("organic"),
    // The agent/agency that owns this link (a `payers` row with role='agent').
    // Nullable: a campaign or worker link has no agent.
    agentPayerId: uuid("agent_payer_id").references(() => payers.id, { onDelete: "cascade" }),
    // The worker that owns this link (a worker's own share). Nullable; SET NULL on
    // DSAR erasure so the PII-free attribution row survives.
    ownerWorkerId: uuid("owner_worker_id").references(() => workers.id, {
      onDelete: "set null",
    }),
    // Stable, non-PII campaign tag (e.g. "gate-qr-pune-01"). Nullable.
    campaignId: text("campaign_id"),
    // CONTEXTUAL DEEP-LINK DATA ONLY — role slug, city slug, campaign context. The
    // app reads this to land the worker on the right screen. Loose JSONB because
    // each campaign owns its own shape, but see the header: NEVER PII.
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Nullable = never expires. A campaign link can be time-boxed; an agent's
    // evergreen link is not.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("referral_links_code_uq").on(t.code),
    // "This agent's links" — the agent dashboard read + the FK cascade's index.
    index("referral_links_agent_payer_id_idx").on(t.agentPayerId),
    index("referral_links_owner_worker_id_idx").on(t.ownerWorkerId),
    // Campaign roll-ups; sparse, so partial.
    index("referral_links_campaign_idx").on(t.campaignId).where(sql`${t.campaignId} IS NOT NULL`),
    // Exactly one owner axis, or none (a pure campaign link). Both set would make
    // "who gets the commission" ambiguous, which is the whole point of this table.
    check(
      "referral_links_single_owner_chk",
      sql`NOT (${t.agentPayerId} IS NOT NULL AND ${t.ownerWorkerId} IS NOT NULL)`,
    ),
    check("referral_links_kind_chk", sql`${t.kind} IN ('agent', 'worker', 'campaign')`),
    check("referral_links_medium_chk", sql`${t.medium} IN ('organic', 'paid')`),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0060

// ---------------------------------------------------------------------------
// referral_clicks — the CLICK LOG, and the row the first-touch claim locks.
//
// WHY IT EXISTS. Attribution needs a per-click TIMESTAMP to enforce a match window,
// and neither `invites` nor `agency_invites` has one (they carry a status enum and
// a mutable `updated_at`, which a later click overwrites). Without this row there is
// no answer to "was the click that produced this install inside the window?".
//
// THE RACE, AND WHAT CLOSES IT. Two concurrent install-referrer posts for the same
// worker used to be able to resolve two claims. The fix is BOTH halves together:
//   1. `SELECT … FOR UPDATE` on the candidate click row inside the claim transaction
//      (see ReferralClickRepository.claimFirstTouch), and
//   2. `referral_clicks_claimed_worker_uq` — a PARTIAL UNIQUE index on
//      `claimed_by_worker_id`. One claimed click per worker, EVER. The loser of a
//      concurrent race hits a unique violation and is neutralised into a no-op.
// (2) is the one that actually holds: a row lock alone cannot stop two transactions
// that pick two DIFFERENT candidate rows, which is exactly what two clicks on two
// different links produces. FIRST TOUCH WINS — the candidate query orders by
// `clicked_at ASC`.
//
// EQUIVALENCE TO A PHONE-HASH KEY (deliberate): the playbook words this rule as
// "unique on the phone hash + active window". `workers.phone_hash` is already UNIQUE,
// so one worker id IS one phone — keying on `claimed_by_worker_id` enforces the
// identical rule WITHOUT copying a phone-derived hash into a second table, which
// would widen the PII surface for no gain (invariant #2). Claims are resolved
// post-auth, so the worker id is always known at claim time.
//
// PII-FREE: `click_hash` is a keyed HMAC-SHA256 over (ip + user-agent) — the same
// idiom as `workers.phone_hash` / `worker_devices.device_hash`. The raw IP and UA are
// NEVER persisted. It exists only to de-duplicate refresh spam within a window.
// ---------------------------------------------------------------------------
export const referralClicks = pgTable(
  "referral_clicks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The resolved link, when the code was one of ours. NULL for a legacy
    // `invites`/`agency_invites` code, which the resolver still logs so the window
    // rule covers links shared before this table existed.
    referralLinkId: uuid("referral_link_id").references(() => referralLinks.id, {
      onDelete: "cascade",
    }),
    // The code AS CLICKED. Needed to join a later claim (which arrives carrying only
    // the code, via the install referrer) back to this row. A bearer token — never
    // logged, never evented.
    code: text("code").notNull(),
    // Keyed HMAC-SHA256 over (ip + user-agent). NEVER the raw values (see header).
    clickHash: text("click_hash").notNull(),
    // Snapshot of the link's medium at click time — a later re-tag of the link must
    // not retroactively change which window a past click was judged under.
    medium: text("medium").$type<ReferralLinkMedium>().notNull().default("organic"),
    // Coarse device class, for funnel diagnostics only. No fingerprint.
    platform: text("platform").$type<ReferralClickPlatform>().notNull().default("other"),
    clickedAt: timestamp("clicked_at", { withTimezone: true }).notNull().defaultNow(),
    // Set ONCE when this click wins a worker's first-touch claim (see header).
    claimedByWorkerId: uuid("claimed_by_worker_id").references(() => workers.id, {
      onDelete: "set null",
    }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
  },
  (t) => [
    // THE FIRST-TOUCH RULE'S TEETH. Partial: unclaimed rows are the overwhelming
    // majority and must not contend on a unique index.
    uniqueIndex("referral_clicks_claimed_worker_uq")
      .on(t.claimedByWorkerId)
      .where(sql`${t.claimedByWorkerId} IS NOT NULL`),
    // The claim-resolution hot path: "unclaimed clicks for this code, oldest first".
    index("referral_clicks_code_clicked_idx").on(t.code, t.clickedAt),
    // Refresh-spam de-duplication within a window.
    index("referral_clicks_hash_idx").on(t.clickHash, t.clickedAt),
    // Link-scoped funnel counts + the FK cascade's index.
    index("referral_clicks_link_idx").on(t.referralLinkId),
    check("referral_clicks_medium_chk", sql`${t.medium} IN ('organic', 'paid')`),
    // A claim is all-or-nothing: both columns set, or neither.
    check(
      "referral_clicks_claim_pair_chk",
      sql`(${t.claimedByWorkerId} IS NULL) = (${t.claimedAt} IS NULL)`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0060

export type ReferralLink = typeof referralLinks.$inferSelect;
export type NewReferralLink = typeof referralLinks.$inferInsert;
export type ReferralClick = typeof referralClicks.$inferSelect;
export type NewReferralClick = typeof referralClicks.$inferInsert;

