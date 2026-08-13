/**
 * Payer domain — payer accounts/orgs/members plus the monetization surface built on
 * them: contact unlocks, credits + ledger, routing, pricing/plans/boosts, resume
 * disclosures, capacity, payment orders, and the AI job-posting chat + form drafts.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import type {
  MessageDirection,
  MessageType,
} from "@badabhai/types";
import { jsonObject } from "./internal/sql-defaults";
import { workers } from "./worker";
import { generatedResumes } from "./profile";
import { jobPostings, jobs } from "./job";

// ---------------------------------------------------------------------------
// payers — the account behind the opaque `payer_id` (ADR-0019 Decision B).
//
// Self-serve makes `payer_id` (today an opaque "faceless-rails" UUID on
// unlocks/payer_credits/posting_plans/resume_disclosures/payer_capacity, NO FK)
// a REAL authenticated account. This table is ADDITIVE: those columns stay opaque
// UUIDs (no FK retrofit here, backward-compatible); a `payers.id` is now a valid
// value for them. `payers` holds payer/employer **B2B contact PII — a NEW PII
// class** (ADR-0019 B-R2, the accepted invariant-#2 extension). Same at-rest
// discipline as `workers` (ADR-0004): contact fields are AES-256-GCM CIPHERTEXT
// (`encryptPii` tokens, key never in the DB); the login email also carries a keyed
// HMAC (`email_hash`) as the brute-force-resistant lookup/dedup key (the only
// email derivative allowed anywhere outside this table). Payer PII NEVER enters
// events/ai_jobs/audit_logs/logs/LLM input — `payer_id` stays the only token.
// RLS-enabled (REVOKE carried by the migration, like workers 0003/0004).
// ---------------------------------------------------------------------------
export type PayerRole = "employer" | "agent";
export type PayerStatus = "pending" | "active" | "suspended";

export const payers = pgTable(
  "payers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    role: text("role").$type<PayerRole>().notNull(),
    // Login email: AES ciphertext at rest + keyed HMAC for lookup/dedup (mirrors
    // workers.phone_e164 / phone_hash). The hash is the unique key.
    emailEnc: text("email_enc").notNull(), // AES-256-GCM ciphertext token
    emailHash: text("email_hash").notNull(), // keyed HMAC-SHA256 (lookup/dedup)
    // Optional contact phone, same two-column pattern (nullable).
    phoneEnc: text("phone_enc"), // AES ciphertext token
    phoneHash: text("phone_hash"), // keyed HMAC-SHA256
    // Business display name — B2B PII; ciphertext at rest (no lookup hash needed).
    orgNameEnc: text("org_name_enc").notNull(), // AES ciphertext token
    status: text("status").$type<PayerStatus>().notNull().default("pending"),
    /**
     * The status a SUSPEND moved the payer OUT of, so REINSTATE can restore it
     * (ADR-0037: "reinstate restores the previous usable state").
     *
     * Load-bearing, not bookkeeping. Suspend accepts BOTH `pending` and `active`;
     * without this column reinstate would have to hardcode `→ active`, which is a
     * BACKDOOR ACTIVATION: suspend a never-verified payer, reinstate, and they land
     * active having never passed OTP — defeating the lifecycle it implements.
     *
     * NULL means "never suspended" (or suspended before this column existed);
     * reinstate then falls back to `pending`, the fail-closed direction. Cleared on
     * reinstate so it only ever describes the CURRENT suspension.
     */
    previousStatus: text("previous_status").$type<PayerStatus>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payers_email_hash_uq").on(t.emailHash),
    // BP-1 — the admin Companies/Agencies keyset (see workers_admin_keyset_idx).
    index("payers_admin_keyset_idx").on(t.createdAt.desc(), t.id.desc()),
  ],
).enableRLS(); // RLS tracked in the model; REVOKE carried by the migration (ADR-0004 posture)

// ---------------------------------------------------------------------------
// payer_orgs — the TENANT ROOT for the payer surface (ADR-0027 / B5.1). An org owns the
// shared postings/candidates/credits/pipeline; its members act on the org's data scoped
// by their org_role. Each pre-B5 payer is backfilled to a SOLO org (root_payer_id = that
// payer + one owner member), so the later payer_id→org_id re-scope (B5.2) is behaviorally
// identical for a 1-member org. PII: org display name is B2B PII → ciphertext at rest
// (name_enc), no lookup hash needed. Multi-org membership is deferred (one org per root).
// ---------------------------------------------------------------------------
export type PayerOrgStatus = "active" | "suspended";
export const payerOrgs = pgTable(
  "payer_orgs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The founding payer (the initial owner). One org per root payer in B5.
    rootPayerId: uuid("root_payer_id")
      .notNull()
      .references(() => payers.id, { onDelete: "restrict" }),
    // Org display name — B2B PII, ciphertext at rest (nullable; backfilled from the root
    // payer's org_name_enc). No lookup hash needed.
    nameEnc: text("name_enc"), // AES ciphertext token
    status: text("status").$type<PayerOrgStatus>().notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One org per root payer (B5 single-org invariant; multi-org would drop this).
    uniqueIndex("payer_orgs_root_payer_id_uq").on(t.rootPayerId),
    check("payer_orgs_status_chk", sql`${t.status} IN ('active', 'suspended')`),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// payer_members — membership of a payer in an org (ADR-0027 / B5.1). One row per
// invited/active/removed member; the invite→accept→remove lifecycle rides `status`
// (soft-delete via removed_at for audit — the payer_member.* events are the audit trail).
// A member is a `payers` login (member_payer_id, NULL until accept) linked to an org with
// an org_role. PII: member email is B2B PII → email_enc (AES) + email_hash (keyed HMAC,
// lookup/dedup within an org) per TD21. The invite token is a BEARER secret → only its
// HASH is stored (invite_token_hash); the raw token rides the accept-link email ONLY and
// is never persisted/logged/evented.
// ---------------------------------------------------------------------------
export type OrgRole = "owner" | "recruiter";
export type PayerMemberStatus = "invited" | "active" | "removed";
export const payerMembers = pgTable(
  "payer_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => payerOrgs.id, { onDelete: "cascade" }),
    // The member's payers login — NULL until they accept the invite and are linked.
    memberPayerId: uuid("member_payer_id").references(() => payers.id, { onDelete: "set null" }),
    emailEnc: text("email_enc").notNull(), // AES ciphertext token
    emailHash: text("email_hash").notNull(), // keyed HMAC-SHA256 (lookup/dedup within an org)
    orgRole: text("org_role").$type<OrgRole>().notNull().default("recruiter"),
    status: text("status").$type<PayerMemberStatus>().notNull().default("invited"),
    // The payer who sent the invite (opaque; audit). Nullable for the backfilled root owner.
    invitedBy: uuid("invited_by").references(() => payers.id, { onDelete: "set null" }),
    // HASH of the single-use accept token — NEVER the raw token (bearer secret).
    inviteTokenHash: text("invite_token_hash"),
    inviteExpiresAt: timestamp("invite_expires_at", { withTimezone: true }),
    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("payer_members_org_id_idx").on(t.orgId),
    index("payer_members_member_payer_id_idx").on(t.memberPayerId),
    // One membership row per (org, email) — re-inviting the same email updates that row.
    uniqueIndex("payer_members_org_email_uq").on(t.orgId, t.emailHash),
    check("payer_members_role_chk", sql`${t.orgRole} IN ('owner', 'recruiter')`),
    check("payer_members_status_chk", sql`${t.status} IN ('invited', 'active', 'removed')`),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// Contact Unlock + Reveal (ADR-0010, Stream A) — the routed-disclosure spine.
//
// All four tables are STRICTLY ADDITIVE and PII-FREE: ids + enums + counts +
// opaque tokens ONLY. The ONLY join back to identity is `unlocks.worker_id` →
// `workers` (where PII already lives, RLS-locked) — exactly like `applications`.
// `payer_id` is the opaque "faceless-rails" payer ref (NO FK, NO `payers` table,
// NO employer PII; ADR-0010 §Decision 0). The raw phone is read transiently from
// `workers` ONLY at reveal time and is NEVER written into ANY of these tables, any
// event payload, `ai_jobs`, `audit_logs`, or any log line (CLAUDE.md invariant 2;
// ADR-0010 §D2 / Phase-0 F-4/F-5). No table below has a phone/name/contact column.
//
// Alpha is MOCK CREDITS ONLY (no real money) and IN-APP RELAY ONLY (no telephony
// provider) — real payment/telephony keys remain hard human-gated escalations
// (ADR-0010 §EXPLICITLY OUT, CLAUDE.md §7). These tables join the RLS backlog
// (TD20) and are ENABLE+FORCE RLS + REVOKE-ALL locked in migration 0014, in the
// same migration that creates them (the proven 0012 pattern).
// ---------------------------------------------------------------------------

/**
 * Unlock lifecycle (ADR-0010 §D6.1). `requested` at entry → `granted` once
 * consent+caps+credit pass → `revealed` after a routed contact attempt → `expired`
 * when the 14-day window lapses → `denied` on any fail-closed gate. Default
 * `requested`.
 */
export type UnlockStatus = "requested" | "granted" | "revealed" | "expired" | "denied";

/**
 * INTERNAL-ONLY deny reason (ADR-0010 §D4 no-oracle rule). Recorded for the audit
 * spine; it is NEVER echoed to a payer (the payer only ever sees a neutral
 * "unavailable" / "payment_required"). Null unless `status='denied'`.
 */
export type UnlockDenyReason = "no_consent" | "capped" | "payment_required" | "unknown_worker";

/**
 * Append-only credit-ledger movement reason (ADR-0010 §D5). `pack_purchase` =
 * a payer bought a credit pack (mock in alpha, see credit-packs.ts); `unlock_debit`
 * = one credit spent to grant an unlock; `refund` = a credit returned; `grant` =
 * an ops/internal top-up (no real money). No currency/PAN/UPI is ever stored —
 * `payment_ref` is an OPAQUE external order id only, never card/PII data.
 */
export type CreditReason = "pack_purchase" | "unlock_debit" | "refund" | "grant";

/**
 * Routed-channel kind (ADR-0010 §D2). Alpha ships `in_app_relay` ONLY — it
 * discloses NO number and needs NO external provider. `proxy_number` is the
 * production routed channel and is human-gated (real telephony key + spend).
 */
export type RoutingChannel = "in_app_relay" | "proxy_number";

// unlocks — one routed-contact GRANT (per payer per candidate profile). PII-FREE.
// Natural key (payer_id, worker_id): per-profile granularity (§Sign-off resolutions)
// — one idempotent unlock per payer per candidate; a retried request converges on
// the same row (last-state-wins; per-attempt audit lives in events). `job_id` is
// OPTIONAL context (granularity is per-profile, not per-(worker, job)).
//
// DPDP erasure posture (ADR-0026 Phase 5, D3): `worker_id` is `onDelete: "set null"`
// + NULLABLE — a worker hard-delete (DSAR) PRESERVES this PII-free PAID grant and
// only nulls the identity join. Cascading here would DESTROY billing history; this
// mirrors the `agency_invites`/`invites.invited_worker_id` "keep INTENT history
// intact" posture. Existing rows keep their (non-null) worker_id; SET NULL fires
// only on a future worker DELETE.
export const unlocks = pgTable(
  "unlocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Opaque payer ref (employer OR agent) — faceless rails, NO FK, NO PII.
    payerId: uuid("payer_id").notNull(),
    // The ONLY join back to identity; PII stays in `workers` (RLS-locked).
    // NULLABLE + onDelete:"set null" — DSAR erasure nulls the join, keeps the
    // PII-free paid-grant row (ADR-0026 Phase 5 D3).
    workerId: uuid("worker_id").references(() => workers.id, { onDelete: "set null" }),
    // Optional job context (per-profile granularity, so nullable). FK to jobs.
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    status: text("status").$type<UnlockStatus>().notNull().default("requested"),
    // INTERNAL audit only — NEVER returned to a payer (no-oracle, §D4). Null unless
    // status='denied' (enforced by the CHECK below).
    denyReason: text("deny_reason").$type<UnlockDenyReason>(),
    // Opaque pointer into `unlock_routing` (server-internal). NOT a contact, NOT a
    // phone. Null until granted. The token itself never leaves the server (F-4).
    routingTokenRef: uuid("routing_token_ref"),
    // Routed contact attempts used (cap enforced in the service chokepoint, §D4).
    revealCount: integer("reveal_count").notNull().default(0),
    grantedAt: timestamp("granted_at", { withTimezone: true }),
    // 14-day access window end (§Sign-off resolutions / §D1). Null until granted.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Per-profile idempotency: at most one unlock per (payer, candidate).
    uniqueIndex("unlocks_payer_worker_uq").on(t.payerId, t.workerId),
    // Ops read: unlocks per worker (also feeds the per-worker cap reads).
    index("unlocks_worker_id_idx").on(t.workerId),
    // Ops/cap read: unlocks per payer.
    index("unlocks_payer_id_idx").on(t.payerId),
    // deny_reason is only valid on a deny (NULL otherwise).
    check("unlocks_deny_reason_chk", sql`${t.denyReason} IS NULL OR ${t.status} = 'denied'`),
  ],
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)

// payer_credits — mock credit balance, one row per payer. Amounts + ids ONLY.
// NO real money in alpha (§D5). balance is a materialization of `credit_ledger`.
export const payerCredits = pgTable(
  "payer_credits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Opaque payer ref (no FK, no PII). One balance row per payer.
    payerId: uuid("payer_id").notNull(),
    // Unlock credits available. Phase-0 F-6: must never go negative.
    balance: integer("balance").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payer_credits_payer_id_uq").on(t.payerId),
    // F-6: balance is never negative (a debit below zero must fail closed).
    check("payer_credits_balance_nonneg_chk", sql`${t.balance} >= 0`),
  ],
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)

// credit_ledger — APPEND-ONLY credit movements (the source of truth; balance is a
// materialization of it). Amounts + ids ONLY. NO currency/PAN/UPI — `payment_ref`
// is an OPAQUE external payment/order id only, NEVER card/PII data (§D5).
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payerId: uuid("payer_id").notNull(),
    // +grant / -debit. Signed credit movement.
    delta: integer("delta").notNull(),
    reason: text("reason").$type<CreditReason>().notNull(),
    // Set for unlock_debit / refund (which unlock spent/returned the credit).
    unlockId: uuid("unlock_id").references(() => unlocks.id, { onDelete: "set null" }),
    // For pack_purchase: the pack code bought (e.g. 'pack_10' | 'pack_25'). Null otherwise.
    packCode: text("pack_code"),
    // The amount CHARGED for this movement, in whole ₹ (integer, never paise) — stamped at
    // purchase time from the resolved pack (D-6). NULLABLE on purpose: only pack_purchase rows
    // carry an amount (debits/ops grants stay null), AND every row written before this column
    // existed is null. History renders the STAMPED value so a later ops price edit can never
    // retroactively rewrite what a past purchase appears to have cost; a null legacy row
    // renders an honest placeholder rather than a fabricated current-catalog price.
    // PII-free (an integer amount, like `delta`). Additive + nullable (invariant #8).
    //
    // ⚠️ MIGRATION 0043 — APPLY BEFORE DEPLOY (owner-apply pending). Both sides name this
    // column EXPLICITLY: the writer (UnlocksRepository.creditPack insert) and the reader
    // (UnlocksRepository.listCreditLedgerByPayer select). App code deployed against an
    // unmigrated DB therefore breaks the ledger INSERT (every pack purchase) AND the
    // history READ — it is not a silently-ignored column. Order: apply 0043, then deploy.
    // Rollback = drop the column (nothing else depends on it).
    priceInr: integer("price_inr"),
    // OPAQUE external payment/order ref ONLY (e.g. a gateway order id) — NEVER card
    // number, UPI handle, or any PII. Null for ops grants / mock debits.
    paymentRef: text("payment_ref"),
    // EXACTLY-ONCE money guard (ADMIN-3a H2). An OPAQUE, caller-supplied stable key for a
    // logical credit movement (e.g. an admin grant). The partial unique index below makes the
    // ledger insert idempotent under at-least-once retry: a re-submit with the SAME key inserts
    // NO second row and changes NO balance. NULLABLE on purpose (NULLS DISTINCT) — movements with
    // no natural dedup key (legacy/mock debits) leave it null and never collide. Carries NO PII /
    // value — an opaque UUID only; the admin.action_performed event is keyed on the SAME value so
    // ledger + spine agree (no double-spend / no money-vs-spine divergence).
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("credit_ledger_payer_id_idx").on(t.payerId),
    // Exactly-once: non-null keys are unique; many NULLs allowed (Postgres NULLS DISTINCT).
    uniqueIndex("credit_ledger_idempotency_key_uq").on(t.idempotencyKey),
    // BP-1 — the admin per-payer ledger keyset. Payer-leading because the admin read is
    // ALWAYS scoped to one payer; a bare (created_at, id) index would not serve it.
    index("credit_ledger_payer_keyset_idx").on(t.payerId, t.createdAt.desc(), t.id.desc()),
    // BP-2 — the PLATFORM-WIDE ledger keyset (Finance → recent movements, all payers). The
    // payer-leading index above cannot serve an unscoped scan; this one can, and it is also
    // what the by-reason aggregate ranges over.
    index("credit_ledger_admin_keyset_idx").on(t.createdAt.desc(), t.id.desc()),
  ],
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)

// unlock_routing — SERVER-SIDE-ONLY routing mapping (ADR-0010 §D2 / Phase-0 F-4/F-5).
// PII-FREE BY CONSTRUCTION: it maps an opaque routing token → a channel + an
// expiring, NON-reversible payer-facing handle. There is ABSOLUTELY NO phone / name
// / contact / proxy-number column here. The raw phone is read transiently from
// `workers.phoneE164` (PiiCryptoService) ONLY inside the reveal handler, handed to
// the relay/provider, and DISCARDED — it is NEVER stored on this row. The
// `routing_token` is the 122-bit server-internal token and NEVER appears in any
// response, event payload, or log (F-4).
export const unlockRouting = pgTable(
  "unlock_routing",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    unlockId: uuid("unlock_id")
      .notNull()
      .references(() => unlocks.id, { onDelete: "cascade" }),
    // 122-bit server-internal token (UUIDv4). NEVER returned/evented (F-4).
    routingToken: uuid("routing_token").notNull(),
    channel: text("channel").$type<RoutingChannel>().notNull(),
    // The payer-facing, NON-reversible, expiring handle for the routed channel —
    // NOT a phone, NOT reversible to one. Alpha: an in-app relay handle.
    relayHandle: text("relay_handle").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The token is the server-internal lookup key; it must be unique.
    uniqueIndex("unlock_routing_routing_token_uq").on(t.routingToken),
    index("unlock_routing_unlock_id_idx").on(t.unlockId),
  ],
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)

// ---------------------------------------------------------------------------
// Monetization + Pricing Engine (ADR-0013) — additive, PII-FREE. The pricing
// catalog VALUES live here (ops-editable, Zod-validated on load by
// @badabhai/pricing, fail-closed). Entitlement tables record paid posting plans /
// boosters and (FREE) resume disclosures. NO raw PII: payer_id is opaque
// faceless-rails (no FK), and the only identity join is *_disclosures.worker_id →
// workers (RLS-locked). Resume bytes / names / download links never live here.
// ---------------------------------------------------------------------------

/** Paid posting plan tier (mirrors @badabhai/pricing PostingTier; kept local to avoid an upward dep). */
export type PostingPlanTier = "standard" | "pro";
/**
 * Posting plan lifecycle (orthogonal to the ADR-0012 job_posting content lifecycle).
 * 'paused' (ADR-0016 D3): a plan whose payer is over their active-vacancy capacity —
 * it is NOT counted as an active vacancy and does NOT serve. Additive enum-widening:
 * the prior three values stay valid (backward-compatible, CLAUDE.md §2 #8 / ADR-0014).
 */
export type PostingPlanStatus = "draft" | "active" | "expired" | "paused";
/**
 * Booster tier. ADDITIVE enum-widening (ADR-0036 §7, migration 0059) — the prior
 * `all_candidates` value stays VALID so every shipped `posting_boosts` row remains
 * readable and its receipt remains priceable (CLAUDE.md §2 #8). It is retired from the
 * OFFERED catalog (`OFFERED_BOOST_TIERS` in @badabhai/pricing), never from history.
 */
export type BoostTier = "all_candidates" | "boost_7" | "boost_15" | "boost_30";
/** Booster lifecycle. */
export type BoostStatus = "active" | "expired";
/** Resume-disclosure lifecycle (ADR-0013 C.3). Resume download is FREE — no payment state. */
export type DisclosureStatus = "requested" | "granted" | "disclosed" | "denied" | "expired";
/** INTERNAL-only deny reason (never returned — no-oracle, ADR-0010 F-3). No "payment_required" (free). */
export type DisclosureDenyReason = "no_consent" | "capped" | "unknown_worker";

// pricing_catalog — the config-builder store (ADR-0013 Decision A). One ACTIVE row
// holds the whole validated catalog as JSON; prior rows are kept as history. The
// engine loads the active row and Zod-validates it (fail-closed to the typed
// default). PII-FREE: codes + integer ₹ amounts + percentages only.
export const pricingCatalog = pgTable(
  "pricing_catalog",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The full catalog payload (products/offers/coupons). Validated by
    // @badabhai/pricing `safeParseCatalog` on load — never trusted unvalidated.
    catalog: jsonb("catalog").notNull(),
    // Monotonic catalog revision (bumped on each ops edit).
    revision: integer("revision").notNull().default(1),
    // Exactly one active row (partial unique index below).
    isActive: boolean("is_active").notNull().default(true),
    // Opaque ops actor who wrote this revision (no PII). Mirrors job_postings.created_by.
    updatedBy: uuid("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At most one active catalog row at a time.
    uniqueIndex("pricing_catalog_active_uq")
      .on(t.isActive)
      .where(sql`${t.isActive}`),
  ],
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)

// posting_plans — a paid plan attached to a job_posting (ADR-0013 B.2). Price/quota/
// window are STAMPED from the catalog at purchase (the row is the receipt). PII-FREE.
export const postingPlans = pgTable(
  "posting_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobPostingId: uuid("job_posting_id")
      .notNull()
      .references(() => jobPostings.id, { onDelete: "cascade" }),
    // Opaque payer (employer OR agent) — faceless rails, NO FK, NO PII.
    payerId: uuid("payer_id").notNull(),
    tier: text("tier").$type<PostingPlanTier>().notNull(),
    // Stamped from the catalog at purchase (10 / 30); the cap on applicant views. This is the
    // IMMUTABLE original receipt — never mutated after purchase (a top-up adds to
    // quotaTopupCount below, NOT here).
    applicantVisibilityQuota: integer("applicant_visibility_quota").notNull(),
    // Additional applicant-visibility views bought AFTER purchase via a quota top-up (B2).
    // Accumulates each top-up so the original receipt (applicantVisibilityQuota) stays
    // immutable; the effective cap the (future) view chokepoint enforces is
    // applicantVisibilityQuota + quotaTopupCount. Each top-up also emits posting_plan.quota_topped.
    quotaTopupCount: integer("quota_topup_count").notNull().default(0),
    // Atomic check-and-increment at the single view chokepoint (ADR-0010 F-2 discipline).
    applicantsViewedCount: integer("applicants_viewed_count").notNull().default(0),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    status: text("status").$type<PostingPlanStatus>().notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("posting_plans_job_posting_id_idx").on(t.jobPostingId),
    index("posting_plans_payer_id_idx").on(t.payerId),
    check("posting_plans_tier_chk", sql`${t.tier} IN ('standard', 'pro')`),
    check("posting_plans_status_chk", sql`${t.status} IN ('draft', 'active', 'expired', 'paused')`),
    check("posting_plans_viewed_nonneg_chk", sql`${t.applicantsViewedCount} >= 0`),
    check("posting_plans_topup_nonneg_chk", sql`${t.quotaTopupCount} >= 0`),
  ],
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)

// posting_boosts — a booster on a job_posting (ADR-0013 B.2). PII-FREE.
export const postingBoosts = pgTable(
  "posting_boosts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobPostingId: uuid("job_posting_id")
      .notNull()
      .references(() => jobPostings.id, { onDelete: "cascade" }),
    payerId: uuid("payer_id").notNull(),
    tier: text("tier").$type<BoostTier>().notNull().default("all_candidates"),
    boostStartsAt: timestamp("boost_starts_at", { withTimezone: true }),
    boostEndsAt: timestamp("boost_ends_at", { withTimezone: true }),
    status: text("status").$type<BoostStatus>().notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("posting_boosts_job_posting_id_idx").on(t.jobPostingId),
    index("posting_boosts_payer_id_idx").on(t.payerId),
    // ADR-0036 §7 — widened ADDITIVELY (migration 0059). `all_candidates` is retained
    // so existing rows still satisfy the CHECK; a narrowing would have failed on them.
    check(
      "posting_boosts_tier_chk",
      sql`${t.tier} IN ('all_candidates', 'boost_7', 'boost_15', 'boost_30')`,
    ),
    check("posting_boosts_status_chk", sql`${t.status} IN ('active', 'expired')`),
  ],
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)

// resume_disclosures — one resume-download GRANT (ADR-0013 C.3). Resume download is
// FREE but is a PII DISCLOSURE — it rides the ADR-0010 consent+caps spine. PII-FREE
// by construction: the resume bytes / name / download link are NEVER here. `resume_ref`
// is an opaque pointer into generated_resumes; worker_id is the only identity join.
//
// DPDP erasure posture (ADR-0026 Phase 5, D3): `worker_id` is `onDelete: "set null"`
// + NULLABLE — a worker hard-delete (DSAR) PRESERVES this PII-free disclosure record
// and only nulls the identity join. Cascading here would DESTROY disclosure history;
// this mirrors the `agency_invites`/`invites.invited_worker_id` "keep INTENT history
// intact" posture. Existing rows keep their (non-null) worker_id; SET NULL fires
// only on a future worker DELETE.
export const resumeDisclosures = pgTable(
  "resume_disclosures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payerId: uuid("payer_id").notNull(),
    // NULLABLE + onDelete:"set null" — DSAR erasure nulls the join, keeps the
    // PII-free disclosure row (ADR-0026 Phase 5 D3).
    workerId: uuid("worker_id").references(() => workers.id, { onDelete: "set null" }),
    // Scope to a posting if downloaded from a candidates page; null for pure search.
    jobPostingId: uuid("job_posting_id").references(() => jobPostings.id, { onDelete: "set null" }),
    // Which resume artifact was disclosed (a pointer, NOT the bytes).
    resumeRef: uuid("resume_ref").references(() => generatedResumes.id, { onDelete: "set null" }),
    status: text("status").$type<DisclosureStatus>().notNull().default("requested"),
    // INTERNAL only — NEVER returned (no-oracle). Null unless status='denied'.
    denyReason: text("deny_reason").$type<DisclosureDenyReason>(),
    disclosedAt: timestamp("disclosed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotent grant per (payer, worker, posting) — mirrors `unlocks` (NULLS DISTINCT
    // means pure-search disclosures with a null posting never collide).
    uniqueIndex("resume_disclosures_payer_worker_posting_uq").on(
      t.payerId,
      t.workerId,
      t.jobPostingId,
    ),
    index("resume_disclosures_worker_id_idx").on(t.workerId),
    index("resume_disclosures_payer_id_idx").on(t.payerId),
    check(
      "resume_disclosures_deny_reason_chk",
      sql`${t.denyReason} IS NULL OR ${t.status} = 'denied'`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)

// payer_capacity — the per-payer ALLOWANCE of concurrently-active vacancies (ADR-0016
// D4, signed PHASE-0 2026-06-17). FACELESS & PII-FREE by construction: `payer_id` is
// the same OPAQUE rail as posting_plans.payer_id — NO FK, NO identity, NO "employer
// entity" (a dead decision). One row per payer caps how many posting_plans they may hold
// in status='active' at once; over-cap plans are 'paused' (ADR-0016 D3) and do not serve.
// The CURRENT active-vacancy count is NOT stored here — it is DERIVED by COUNT over
// posting_plans (status='active') grouped by payer_id (no drift-prone side counter,
// ADR-0010 F-2 discipline). This table holds only the allowance + its validity window.
export const payerCapacity = pgTable(
  "payer_capacity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Opaque payer (employer OR agent) — faceless rails, NO FK, NO PII.
    payerId: uuid("payer_id").notNull(),
    // How many posting_plans this payer may hold in status='active' concurrently.
    maxActiveVacancies: integer("max_active_vacancies").notNull(),
    // The capacity-catalog tier code that granted this allowance (a stable code, NOT
    // PII). Nullable: a manually-granted/seeded allowance need not cite a tier.
    sourceTier: text("source_tier"),
    // Optional validity window — null = no expiry.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One capacity row per payer (this unique index also serves payer_id lookups —
    // no separate payer_id index needed).
    uniqueIndex("payer_capacity_payer_id_uq").on(t.payerId),
    check("payer_capacity_max_nonneg_chk", sql`${t.maxActiveVacancies} >= 0`),
  ],
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)

// ===========================================================================
// Matching V1 — Workstream 3 spine (migration 0058): payment_orders +
// referral_bonus_accruals. Authored in the SAME train so Divyanshu applies ONE ordered
// sequence, not two.
//
// ⚠️ STRUCTURE ONLY. Creating `payment_orders` does NOT enable real money: real
// payment-provider keys and spend stay a hard human-gated escalation (CLAUDE.md §7,
// ADR-0010 §EXPLICITLY OUT, ADR-0013). The table exists so the idempotency key is a DB
// constraint from day one rather than something bolted on after the first double-charge.
//
// PII-FREE (invariant #2): opaque payer/worker UUIDs, integer ₹ amounts, pack codes,
// provider order/payment ids. ABSOLUTELY NO card number, UPI handle, VPA, bank account,
// billing name, or address column here — the same line `credit_ledger.payment_ref` has
// held since ADR-0010 §D5. Provider ids are OPAQUE external references, not PII.
// ===========================================================================

/** Payment order lifecycle. `created` at intent → `paid` on a verified provider callback → `failed`. */
export type PaymentOrderStatus = "created" | "paid" | "failed";

// payment_orders — one row per checkout intent against a payment provider.
export const paymentOrders = pgTable(
  "payment_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Opaque payer ref — the "faceless-rails" pattern, NO FK (mirrors payer_credits /
    // credit_ledger, which this sits in front of).
    payerId: uuid("payer_id").notNull(),
    // Which credit pack was bought (e.g. 'pack_10'); resolved against @badabhai/pricing.
    packCode: text("pack_code").notNull(),
    // Whole ₹, never paise (house convention — see credit_ledger.price_inr).
    amountInr: integer("amount_inr").notNull(),
    // How many credits this order buys, RESOLVED FROM THE CATALOG ONCE AT ORDER CREATION
    // and never re-read afterwards.
    //
    // WHY IT IS STORED RATHER THAN LOOKED UP AT CAPTURE: the order row is the receipt, and
    // a receipt with only half the transaction on it is not a receipt. `amount_inr` was
    // already stamped here, but the credits were not — so if ops re-priced or re-sized a
    // pack between order creation and capture, the buyer paid the STAMPED amount and was
    // granted the pack's THEN-CURRENT credits. Two sources of truth for one transaction,
    // over an unbounded window (a browser tab left open across a pricing change is enough),
    // producing an unreconcilable ledger. Stamping both makes a mid-flight catalog change
    // structurally unable to touch an order that already exists.
    creditsGranted: integer("credits_granted").notNull(),
    provider: text("provider").notNull().default("razorpay"),
    // The provider's own order id. OPAQUE — never parsed, never a PII carrier.
    providerOrderId: text("provider_order_id").notNull(),
    status: text("status").$type<PaymentOrderStatus>().notNull().default("created"),
    // The provider's payment reference, stamped when the order settles. Opaque.
    providerPaymentRef: text("provider_payment_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // ── THE PAYMENT IDEMPOTENCY KEY ───────────────────────────────────────────
    // (provider, provider_order_id) is UNIQUE, and that uniqueness IS the idempotency
    // guarantee: a webhook redelivery, a double-tapped Pay button, or an at-least-once
    // retry all collide here and insert NO second order — so no second credit grant.
    // It is a DB constraint, not an application check, precisely because the application
    // check is the thing that races. `provider` is part of the key so two providers can
    // never be assumed to have disjoint id spaces.
    uniqueIndex("payment_orders_provider_order_uq").on(t.provider, t.providerOrderId),
    // Ops/payer read: this payer's orders, newest first.
    index("payment_orders_payer_created_idx").on(t.payerId, t.createdAt),
    // BP-2 — the admin Transactions keyset (all payers, newest first). The payer-leading
    // index above cannot serve an unscoped scan.
    index("payment_orders_admin_keyset_idx").on(t.createdAt.desc(), t.id.desc()),
    // A zero/negative-amount order is always a bug, never a real purchase.
    check("payment_orders_amount_pos_chk", sql`${t.amountInr} > 0`),
    // Same reasoning for the grant side: an order that buys zero (or negative) credits is
    // a resolver bug, and a DB constraint is the only place it cannot be forgotten.
    check("payment_orders_credits_pos_chk", sql`${t.creditsGranted} > 0`),
    check("payment_orders_status_chk", sql`${t.status} IN ('created', 'paid', 'failed')`),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0058

// ===========================================================================
// ADR-0035 — AI job-posting chat + cross-device drafts (migration 0050)
// ---------------------------------------------------------------------------
// Three ADDITIVE tables. The two chat tables are the PAYER-SIDE SIBLINGS of the
// worker `chat_sessions` / `chat_messages` pair above and deliberately mirror
// their shape — they are NOT a retrofit of them: the shipped worker tables carry
// a hard NOT NULL FK to `workers.id`, and retargeting that at a payer would mutate
// a shipped, in-use FK (invariant #8). Same "coexist, don't retrofit" call
// ADR-0012 made for `job_postings` vs `jobs` and ADR-0022 §d for `agency_invites`
// vs `invites`.
//
// PRIVACY (invariant #2) — these tables hold NO raw PII:
//  * The payer is referenced only by the opaque `payers.id`. Payer contact PII
//    (email/phone/org name) stays encrypted on the `payers` row (ADR-0004) and is
//    never copied here. The chat NEVER asks for the payer's org name — it is
//    auto-filled server-side from `payers.org_name_enc` at publish time and
//    interpolated post-hoc (the AI-PERSONA-2 pattern), never sent to the LLM and
//    never stored in `conversation_state` / `draft`.
//  * `body_text` is payer-typed free text ABOUT A JOB (role, skills, location,
//    pay). Treat it as untrusted free text: it must NEVER be copied into an event
//    payload, `ai_jobs`, `audit_logs`, or a log line — the `job_posting_chat.*`
//    events carry ids/enums/message_type ONLY. It is pseudonymized (fail-closed,
//    invariant #3) before any LLM call, because a payer can still type a phone
//    number or a person's name into free text.
//
// RLS: `.enableRLS()` tracked in the model; FORCE + REVOKE for all Data-API roles
// are hand-appended to migration 0050 (drizzle-kit emits ENABLE only) — the same
// spine posture as 0048/0045/0029. New tables must also be registered in
// `tests/e2e/rls-spine.e2e.test.ts` LOCKED_TABLES (the no-drift guard).
// ===========================================================================

/** Lifecycle of an AI job-posting chat session (ADR-0035 §Decision 1). */
export type PayerJobPostingChatStatus = "active" | "draft_ready" | "published" | "abandoned";

// The conversation container — one row per job-posting chat a payer starts.
// CROSS-DEVICE RESUME: state is keyed to `payer_id` (the account), never to a
// device or browser session, so any device the payer is logged into resumes it.
export const payerJobPostingChatSessions = pgTable(
  "payer_job_posting_chat_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payerId: uuid("payer_id")
      .notNull()
      .references(() => payers.id, { onDelete: "cascade" }),
    status: text("status").$type<PayerJobPostingChatStatus>().notNull().default("active"),
    // Interview progress carried across turns: the AI service's JobPostingChatState
    // (topic ordering, asked ids, collected answers). JOB signals only — never the
    // payer's identity/org name; never copied into `events`. Loose JSONB by design
    // (flexible state), exactly like `chat_sessions.conversation_state`; apps/api
    // casts to the ai-contracts JobPostingChatState at the boundary.
    conversationState: jsonb("conversation_state").$type<Record<string, unknown>>(),
    // Latest JobPostingDraft snapshot (role_title, skill phrases, location_label,
    // vacancy_band, pay range, shift, benefits, requirements, description...). Loose
    // JSONB here; validated against PayerCreateJobPostingSchema at publish time.
    // Free-text draft VALUES never enter an event payload — only field KEYS/ids do.
    draft: jsonb("draft").$type<Record<string, unknown>>(),
    // Set once the session publishes; SET NULL so deleting a posting keeps the
    // conversation history intact (the chat outlives the row it produced).
    publishedJobPostingId: uuid("published_job_posting_id").references(() => jobPostings.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    // Backs the cross-device "continue where I left off" list (own sessions).
    index("payer_job_posting_chat_sessions_payer_id_idx").on(t.payerId),
    // Pin the lifecycle union at the DB (the text+$type+CHECK convention — see header).
    check(
      "payer_job_posting_chat_sessions_status_chk",
      sql`${t.status} IN ('active', 'draft_ready', 'published', 'abandoned')`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0050

// The transcript. Mirrors `chat_messages` (same direction/message_type/body_text/
// metadata shape) and REUSES the shared MessageDirection / MessageType unions —
// no new message vocabulary is introduced.
export const payerJobPostingChatMessages = pgTable(
  "payer_job_posting_chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => payerJobPostingChatSessions.id, { onDelete: "cascade" }),
    // DENORMALIZED owner (ADR-0035 §Decision 1), exactly like `chat_messages.worker_id`:
    // lets `assertPayerOwns` check ownership on a message read without joining through
    // the session table on every turn.
    payerId: uuid("payer_id")
      .notNull()
      .references(() => payers.id, { onDelete: "cascade" }),
    direction: text("direction").$type<MessageDirection>().notNull(),
    messageType: text("message_type").$type<MessageType>().notNull().default("text"),
    // Payer-typed free text about a JOB. NEVER into events / ai_jobs / audit_logs /
    // logs; pseudonymized fail-closed before any LLM call (see the section header).
    bodyText: text("body_text"),
    metadata: jsonb("metadata").notNull().default(jsonObject),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Transcript hydration for one session (the :id/messages read).
    index("payer_job_posting_chat_messages_session_id_idx").on(t.sessionId),
    // Owner-scoped reads without a join (the denormalized-tenancy hot path).
    index("payer_job_posting_chat_messages_payer_id_idx").on(t.payerId),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0050

// payer_form_drafts — a GENERIC cross-device draft-persistence primitive.
//
// DELIBERATE FORWARD SCAFFOLDING — NOT DEAD CODE. ADR-0035 §Decision 1 ships this
// with NO consumer in this slice on purpose: the job-posting chat persists its own
// draft in `payer_job_posting_chat_sessions.draft` above, not here. This table is
// the reusable "resume any half-filled payer form on another device" primitive for
// future workstreams. Per ADR-0035 §Consequences, if no future workstream claims it
// within a reasonable window it should be RECONSIDERED (via an ADR) rather than
// silently deleted as unused surface.
//
// PII: none. `state` is a form snapshot keyed to the opaque `payer_id`; the same
// no-free-text-into-events rule as the chat tables applies to anything stored here.
export const payerFormDrafts = pgTable(
  "payer_form_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payerId: uuid("payer_id")
      .notNull()
      .references(() => payers.id, { onDelete: "cascade" }),
    // Which form this draft belongs to (e.g. "job_posting"). Free-form on purpose —
    // a new consumer must not need a migration to claim a namespace.
    formType: text("form_type").notNull(),
    // The form snapshot. Loose JSONB by design; each consumer owns its own shape.
    state: jsonb("state").$type<Record<string, unknown>>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At most one live draft per (payer, form) — upsert target (ON CONFLICT DO UPDATE).
    // Also serves the owner-scoped read, so no separate payer_id index is needed.
    uniqueIndex("payer_form_drafts_payer_form_uq").on(t.payerId, t.formType),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0050

export type PayerJobPostingChatSession = typeof payerJobPostingChatSessions.$inferSelect;
export type NewPayerJobPostingChatSession = typeof payerJobPostingChatSessions.$inferInsert;
export type PayerJobPostingChatMessage = typeof payerJobPostingChatMessages.$inferSelect;
export type NewPayerJobPostingChatMessage = typeof payerJobPostingChatMessages.$inferInsert;
export type PayerFormDraft = typeof payerFormDrafts.$inferSelect;
export type NewPayerFormDraft = typeof payerFormDrafts.$inferInsert;

