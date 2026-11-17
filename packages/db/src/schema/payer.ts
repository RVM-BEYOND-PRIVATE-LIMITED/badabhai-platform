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
  CreditLotSource,
  MessageDirection,
  MessageType,
  PaymentOrderOrigin,
  PaymentOrderProductKind,
  PaymentOrderStatus as TypesPaymentOrderStatus,
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
/**
 * `archived` (#2564) — an admin took the company down. Reversible: restore returns each login
 * to its `previous_status`. Like `suspended` it cannot sign in, post or be served; it is a
 * separate value so "we froze this account" and "this company is gone" stay distinguishable.
 */
export type PayerStatus = "pending" | "active" | "suspended" | "archived";
export const PAYER_STATUSES = [
  "pending",
  "active",
  "suspended",
  "archived",
] as const satisfies readonly PayerStatus[];

export const payers = pgTable(
  "payers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    role: text("role").$type<PayerRole>().notNull(),
    // Login email: AES ciphertext at rest + keyed HMAC for lookup/dedup (mirrors
    // workers.phone_e164 / phone_hash). The hash is the unique key.
    //
    // NULLABLE since #2497 (phone-only signup): a payer created by phone has no
    // email until they add one. Reads MUST handle null (see `decryptContact`).
    emailEnc: text("email_enc"), // AES-256-GCM ciphertext token
    emailHash: text("email_hash"), // keyed HMAC-SHA256 (lookup/dedup)
    // Optional contact phone, same two-column pattern (nullable).
    phoneEnc: text("phone_enc"), // AES ciphertext token
    phoneHash: text("phone_hash"), // keyed HMAC-SHA256
    // Business display name — B2B PII; ciphertext at rest (no lookup hash needed).
    orgNameEnc: text("org_name_enc").notNull(), // AES ciphertext token
    /**
     * #2497 — deterministic lookup key for EXACT company/agency-name password login.
     * `HMAC(normOrgName)` with the server pepper (`payer_org:` domain), indexed but
     * deliberately NOT unique: legitimate duplicate company names exist ("Sharma
     * Trading"), so a multi-match logs in NOBODY (neutral 401, no enumeration) and
     * the payer uses email/phone instead. NULL for rows created before this column
     * (lazily filled on the next successful login) and for names that hash to
     * nothing. NEVER the raw name — the spine rule (§2) applies to this column too.
     */
    orgNameLookupHash: text("org_name_lookup_hash"), // keyed HMAC-SHA256 of the normalized org name
    /**
     * #2497 — scrypt password hash token (`password-v1.<salt>.<derived>`, see
     * `hashPassword` in `../crypto`), set ONLY via `POST /payer/password/set`
     * (bearer) after an OTP verification. NULL = no password (OTP-only account).
     * Never logged, never evented — only `password_set_at` (a timestamp) may leave
     * this row.
     */
    passwordHash: text("password_hash"), // self-encoded scrypt token
    /** When the current `password_hash` was stored. NULL alongside a NULL hash. */
    passwordSetAt: timestamp("password_set_at", { withTimezone: true }),
    /**
     * The pepper version that produced `password_hash` (mirrors the worker-PIN
     * `pepperVersion` pattern: a future v2 pepper rehashes on successful verify).
     * NULL alongside a NULL hash; today only v1 exists and anything else fails
     * closed at verify time.
     */
    passwordPepperVersion: integer("password_pepper_version"),
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
    /**
     * #2563 — true while the stored password is a TEMPORARY one an admin issued. A
     * password sign-in with this set returns `password_change_required` and mints NO
     * session; email-code sign-in refuses with 409 for the same reason, so the code
     * door cannot bypass the change. Cleared in the same write that stores the
     * payer's own password.
     */
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    /**
     * #2563 — when an admin revoked password sign-in. A non-NULL value with no newer
     * `password_set_at` means password sign-in is off; email-code sign-in still works.
     * Cleared when a new password is stored.
     */
    passwordRevokedAt: timestamp("password_revoked_at", { withTimezone: true }),
    /**
     * #2563 - sessions created before this instant are dead. An admin issue/revoke
     * stamps it and ends every session. A self-service password set does NOT stamp it: that
     * would reject the caller's own live session, so it revokes the OTHER sessions through
     * the session index instead and keeps the caller signed in. NULL (every payer on deploy)
     * leaves sessions unaffected.
     */
    sessionsValidAfter: timestamp("sessions_valid_after", { withTimezone: true }),
    /** #2563 — last successful payer sign-in (OTP or password). */
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    /**
     * #2564 — whole-word company-name search for the admin Companies list. Keyed HMACs of each
     * folded name word under the `company:` domain (`NameTokenService`, ADR-0062 §3.6 keys —
     * never `PII_HASH_PEPPER`), written by the same helper that writes `org_name_enc`, so a
     * rename can never leave a stale token. `[]` + NULL kid = not tokenised (keys unset, an
     * already-encrypted team-member copy, or a row not yet backfilled). Never the name itself.
     */
    orgNameTokenHashes: text("org_name_token_hashes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    orgNameTokenKeyId: text("org_name_token_key_id"),
    /**
     * #2746 — test-traffic marker for a COMPANY (the `workers.is_test_account` twin). Set only
     * by an explicit ops act; rows a test company creates copy it (`campus_drive_requests.is_test`,
     * #2749's credit lots) so reports can split real from test. Default FALSE keeps every
     * existing company on today's behaviour.
     */
    isTestAccount: boolean("is_test_account").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payers_email_hash_uq").on(t.emailHash),
    // #2564 — the payer lifecycle, pinned for the first time (PAY-DB-08). The migration
    // DROPs IF EXISTS first so it is safe on any database a hand-applied CHECK reached.
    check("payers_status_chk", sql`${t.status} IN ('pending', 'active', 'suspended', 'archived')`),
    // #2564 — company-name token membership (`@>`) for the admin list.
    index("payers_org_name_tokens_gin_idx").using("gin", t.orgNameTokenHashes),
    // #2497 — exact org-name lookups (non-unique: duplicate names log in NOBODY) and
    // phone lookups for login/request+verify by contact. No uniqueness: historical
    // rows may already share a phone, and a unique index would fail the migration.
    index("payers_org_lookup_hash_idx").on(t.orgNameLookupHash),
    index("payers_phone_hash_idx").on(t.phoneHash),
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
    // Member contact for the invite→accept match (email today; invites are email-based).
    // NULLABLE since #2497: a phone-only founder has no email — their owner row carries
    // NULLs here and is keyed by member_payer_id instead (see ensureSoloOrg). The
    // (org_id, email_hash) dedup stays exactly as-is for email members; NULLs are
    // distinct in Postgres, so phone-only founder rows never collide with anything.
    emailEnc: text("email_enc"), // AES ciphertext token
    emailHash: text("email_hash"), // keyed HMAC-SHA256 (lookup/dedup within an org)
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
 * an ops/internal top-up (no real money); `expired` = a lot's unspent credits removed when its
 * `expires_at` passed (#2749, migration 0174: one line per lot, ever, keyed
 * `credit_lot_expired:<lot id>`). No currency/PAN/UPI is ever stored — `payment_ref` is an
 * OPAQUE external order id only, never card/PII data.
 *
 * `reason` is plain `text` with no CHECK, so a new value needs no migration — but every reader
 * with a closed set of its own (the admin finance filter, the payment-history mapping, the
 * admin-web parsers) must learn it in the same change. `returned` / `waived` / `welcome` /
 * `goodwill` arrive with #2750.
 */
export type CreditReason = "pack_purchase" | "unlock_debit" | "refund" | "grant" | "expired";

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
    // #2033 (migration 0132) — optional COMPANY-posting context, the `job_postings` twin of
    // `job_id`. A payer-session unlock made from one of the payer's own postings stores that
    // posting here (job_id stays null — its FK can only hold a `jobs` id, #1903). At most one
    // of the two is set by the writer. Same posture as `resume_disclosures.job_posting_id`:
    // nullable, SET NULL on a posting delete, no backfill (older rows read null = "no context").
    jobPostingId: uuid("job_posting_id").references(() => jobPostings.id, { onDelete: "set null" }),
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

// ===========================================================================
// credit_lots — a wallet's balance, as lots that may expire (#2749, migration 0174)
// ===========================================================================
//
// ONE ROW PER GRANT INTO A WALLET: a pack bought, an ops grant, the free-tier grant, and (from the
// 0174 backfill) one `legacy` lot per balance that existed before lots did. `payer_id` is the
// WALLET key — the same key as `payer_credits.payer_id` (the tenant key, ADR-0053), so a team
// spends one set of lots. No FK, like `payer_credits`: faceless rails.
//
// THE INVARIANT: per wallet, `payer_credits.balance = Σ credits_remaining` over its lots, and
// `balance = Σ credit_ledger.delta`. Every writer goes through `credit-wallet.ts`, under the wallet
// row lock (wallet row → lots → ledger, one order everywhere), so the three move together.
//
// SPEND ORDER: the open lot that expires soonest, a lot that never expires last
// (`expires_at ASC NULLS LAST, created_at ASC, id ASC`; brief 7, register B7-08).
//
// EXPIRY: an open lot past `expires_at` is closed by the spend path or the `credit-lot-expiry`
// sweep with ONE `expired` ledger line (idempotency key `credit_lot_expired:<id>`): remaining → 0,
// `expired_at` stamped. `expires_at` NULL = never expires; a `pack` lot gets `grant time + validityDays` (#2749 PR 3).
//
// Billing records: NOT erased with the payer account (no FK to `payers`, like the ledger).
// NOT PII: opaque ids, integers, a closed source code, a pack code and dates.
export const creditLots = pgTable(
  "credit_lots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The wallet key (tenant key) — the same value as payer_credits.payer_id. No FK.
    payerId: uuid("payer_id").notNull(),
    /** One of `CREDIT_LOT_SOURCES` (@badabhai/types). */
    source: text("source").$type<CreditLotSource>().notNull(),
    // The pack a `pack` lot came from (e.g. 'pack_50'). Null for every other source.
    packCode: text("pack_code"),
    // The paid Razorpay order a lot came from. UNIQUE (partial, below): one lot per order, so a
    // settle replay can never add a second lot even past the ledger's own key.
    paymentOrderId: uuid("payment_order_id").references(() => paymentOrders.id),
    creditsGranted: integer("credits_granted").notNull(),
    creditsRemaining: integer("credits_remaining").notNull(),
    // NULL = never expires.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // Stamped when the lot is expired (its remaining credits removed with an `expired` line).
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    // A staff test company's lot (plan §14: the one live pilot purchase is marked is_test).
    isTest: boolean("is_test").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The spend / align read: a wallet's OPEN lots in spend order (btree ASC is NULLS LAST).
    index("credit_lots_open_spend_idx")
      .on(t.payerId, t.expiresAt, t.createdAt, t.id)
      .where(sql`${t.creditsRemaining} > 0`),
    // The sweep read: open lots that can expire, by date.
    index("credit_lots_due_idx")
      .on(t.expiresAt)
      .where(sql`${t.creditsRemaining} > 0 AND ${t.expiresAt} IS NOT NULL`),
    // One lot per paid order.
    uniqueIndex("credit_lots_payment_order_uq")
      .on(t.paymentOrderId)
      .where(sql`${t.paymentOrderId} IS NOT NULL`),
    // `CREDIT_LOT_SOURCES`, spelled out because a CHECK is static SQL (0174's test pins the copy).
    check(
      "credit_lots_source_chk",
      sql`${t.source} IN ('pack', 'welcome', 'goodwill', 'returned', 'migrated', 'legacy')`,
    ),
    check("credit_lots_granted_pos_chk", sql`${t.creditsGranted} > 0`),
    check(
      "credit_lots_remaining_range_chk",
      sql`${t.creditsRemaining} >= 0 AND ${t.creditsRemaining} <= ${t.creditsGranted}`,
    ),
    // An expired lot holds nothing.
    check(
      "credit_lots_expired_empty_chk",
      sql`${t.expiredAt} IS NULL OR ${t.creditsRemaining} = 0`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + four REVOKEs carried by migration 0174

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
    // logical credit movement (e.g. an admin grant). The unique index below makes the ledger
    // insert idempotent under at-least-once retry: a re-submit with the SAME key inserts NO second
    // row and changes NO balance. It is a FULL unique index on a nullable column, not a partial
    // one: NULLABLE on purpose (NULLS DISTINCT) — movements with no natural dedup key
    // (legacy/mock debits) leave it null and never collide. Carries NO PII / value — an opaque key
    // only; the admin.action_performed event is keyed on the SAME value so ledger + spine agree
    // (no double-spend / no money-vs-spine divergence).
    idempotencyKey: text("idempotency_key"),
    // #2749 (migration 0174) — the lot this movement added to, spent from or expired. Null for
    // every line written before 0174 (the backfill writes no ledger line; the `legacy` lots it
    // creates stand for what those lines already granted). No cascade: lots are never deleted.
    //
    // ⚠️ APPLY BEFORE DEPLOY: Drizzle names every model column in each insert, so every ledger
    // write (every purchase, unlock and grant) fails against a database without this column.
    lotId: uuid("lot_id").references(() => creditLots.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("credit_ledger_payer_id_idx").on(t.payerId),
    // Exactly-once: non-null keys are unique; many NULLs allowed (Postgres NULLS DISTINCT).
    uniqueIndex("credit_ledger_idempotency_key_uq").on(t.idempotencyKey),
    // #2749 — a lot's movements (and the FK's referencing-side index).
    index("credit_ledger_lot_id_idx").on(t.lotId),
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
    // E0 item 1 — the resolution lookup key. The handle had NO index and no unique
    // constraint until now (PARKED/HALT.md finding), so a `relay_handle -> routing row`
    // read would seq-scan. Unique is correct, not merely faster: handles are
    // `relay_<unlockId>_<randomUUID>` (unique by construction) and a repeat reveal
    // re-serves the SAME row since P-021 was fixed (one routing row per unlock), so two
    // candidate rows must never be silently possible.
    uniqueIndex("unlock_routing_relay_handle_uq").on(t.relayHandle),
  ],
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)

/** Which way a relay message travelled. Closed vocabulary (E0, docs/agent/phases/E0_BUILD.md item 2). */
export type RelayMessageDirection = "payer_to_worker" | "worker_to_payer";
/** The two body shapes: a closed template for the payer's opening message, free text after. */
export type RelayMessageKind = "template" | "text";
/**
 * The typed body union — the compile-time half of the two-shape rule (§B ruling,
 * docs/decisions/E0_RELAY_DECISION_2026-09.md). The database CHECK mirrors it.
 */
export type RelayMessageBody =
  | { template_id: string; params: Record<string, string> }
  | { text: string };

// relay_messages — the payer↔worker in-app relay (E0, docs/agent/phases/E0_BUILD.md item 2).
//
// PII-FREE BY CONSTRUCTION, exactly like `unlock_routing` above: the row carries the
// unlock join, a direction, a body and timestamps — NEVER a phone, a name, an employer,
// or an email. The raw phone is not decryptable on this path at all.
//
// THE BODY IS TWO-SHAPED (§B ruling): the payer's OPENING message is a closed template
// (`kind='template'`, a `template_id` plus a closed parameter set), so a leak in the
// first message is a compile error rather than a review miss; after the worker has
// replied — an affirmative act by the party the property protects — the thread is free
// text both ways (`kind='text'`).
//
// THE CHECK BELOW ENFORCES EACH ROW'S SHAPE ONLY. "No payer free text before the
// worker's first reply" is THREAD state (an EXISTS over earlier rows), enforced in the
// service; do not read the CHECK as the whole rule. And INTENT IS UNSOLVED — "mera
// number profile pe hai", a number split across two messages, "WhatsApp pe naam se
// search karo" — shape does not address it and this schema does not claim to.
export const relayMessages = pgTable(
  "relay_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    unlockId: uuid("unlock_id")
      .notNull()
      .references(() => unlocks.id, { onDelete: "cascade" }),
    direction: text("direction").$type<RelayMessageDirection>().notNull(),
    kind: text("kind").$type<RelayMessageKind>().notNull(),
    // Required iff kind='template' (the CHECK below mirrors the rule).
    templateId: text("template_id"),
    // `{template_id, params}` for a template row; `{text}` for a text row.
    body: jsonb("body").$type<RelayMessageBody>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Set by the worker's read route (E0 item 3). AUDIT ONLY — no payer-visible read
    // receipt exists (E0_BUILD "OUT OF SCOPE": read receipts).
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [
    // A thread is read by unlock, oldest-first.
    index("relay_messages_unlock_id_created_idx").on(t.unlockId, t.createdAt),
    check(
      "relay_messages_direction_chk",
      sql`${t.direction} IN ('payer_to_worker', 'worker_to_payer')`,
    ),
    check("relay_messages_kind_chk", sql`${t.kind} IN ('template', 'text')`),
    // The two shapes, on the row: a template row has a template_id and no `text` key;
    // a text row has no template_id and no `template_id` key in the body.
    check(
      "relay_messages_body_shape_chk",
      sql`(${t.kind} = 'template' AND ${t.templateId} IS NOT NULL AND NOT (${t.body} ? 'text')) OR (${t.kind} = 'text' AND ${t.templateId} IS NULL AND NOT (${t.body} ? 'template_id'))`,
    ),
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
    // #2565 (B11) — the whole-₹ price STAMPED at purchase (quote.finalInr). NULLABLE on
    // purpose: every row written before this column existed is null and renders as
    // "not recorded" (never guessed from the current catalog). PII-free (an integer).
    // Additive + nullable (invariant #8).
    priceInr: integer("price_inr"),
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
    // #2565 (B11) — the whole-₹ price STAMPED at purchase. NULL = pre-column row,
    // rendered as "not recorded", never back-guessed. Additive + nullable.
    priceInr: integer("price_inr"),
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
    // #2565 (B11) — the whole-₹ price of the LAST capacity purchase that wrote this
    // row. NULL = pre-column row or a manual grant, rendered as "not recorded".
    // Per-purchase history lives on the `capacity.purchased` event spine; this column
    // is the receipt on the CURRENT allowance only. Additive + nullable.
    priceInr: integer("price_inr"),
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

// plan_quota_topups — ONE ROW PER quota top-up purchase (B2 receipt, #2565 B11).
//
// A top-up previously existed only as an increment of `posting_plans.quota_topup_count`
// plus a `posting_plan.quota_topped` event — so per-top-up ₹ history was event-only and
// the company timeline had no row to join. This table is the additive receipt: one row
// per purchase, stamped with the tier, the views added and the whole-₹ price.
//
// PII-FREE (ids + codes + counts + integer ₹, like every other monetization table).
// `payer_id` is the same opaque faceless rail. `plan_id` cascades (a deleted plan's
// top-ups go with it, exactly as the plan row does); `job_posting_id` SET NULLs so a
// posting delete that somehow bypasses the plan cascade still keeps the PAID top-up
// row (billing history is never destroyed by a content delete).
export const planQuotaTopups = pgTable(
  "plan_quota_topups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => postingPlans.id, { onDelete: "cascade" }),
    jobPostingId: uuid("job_posting_id").references(() => jobPostings.id, {
      onDelete: "set null",
    }),
    // Opaque payer (employer OR agent) — faceless rails, NO FK, NO PII.
    payerId: uuid("payer_id").notNull(),
    // The quota_topup catalog tier bought (e.g. topup_10).
    tier: text("tier").notNull(),
    // Views added by THIS top-up (the plan's quotaTopupCount grows by this much).
    quotaAdded: integer("quota_added").notNull(),
    // Whole-₹ price STAMPED at purchase. NULL = backfilled-from-event row whose event
    // carried no price (older events always carry one, so this is the "not recorded"
    // bucket, never a guess). New writes always stamp a price.
    priceInr: integer("price_inr"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("plan_quota_topups_plan_id_idx").on(t.planId),
    index("plan_quota_topups_payer_id_idx").on(t.payerId),
    index("plan_quota_topups_payer_created_idx").on(t.payerId, t.createdAt),
    check("plan_quota_topups_added_pos_chk", sql`${t.quotaAdded} > 0`),
  ],
).enableRLS();

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

/**
 * Payment order lifecycle (`PAYMENT_ORDER_STATUSES`, @badabhai/types): `created` at intent →
 * `paid` on a verified provider capture → `failed`; `held` (#2749, migration 0176) when the
 * captured amount is not the order's total — nothing granted, never settleable.
 */
export type PaymentOrderStatus = TypesPaymentOrderStatus;

// payment_orders — one row per checkout intent against a payment provider.
export const paymentOrders = pgTable(
  "payment_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Opaque payer ref — the "faceless-rails" pattern, NO FK (mirrors payer_credits /
    // credit_ledger, which this sits in front of).
    payerId: uuid("payer_id").notNull(),
    // What the order sells (`PAYMENT_ORDER_PRODUCT_KINDS`, #2749 / migration 0176). Defaulted, so
    // every pre-0176 row and an old build's insert read `credit_pack`. #2751 widens the CHECK.
    productKind: text("product_kind")
      .$type<PaymentOrderProductKind>()
      .notNull()
      .default("credit_pack"),
    // Which credit pack was bought (e.g. 'pack_10'); resolved against @badabhai/pricing.
    // NULLABLE since 0176 so a non-pack product (#2751) can be ordered; a `credit_pack` order still
    // requires it (`payment_orders_pack_code_chk`).
    packCode: text("pack_code"),
    // Whole ₹, never paise (house convention — see credit_ledger.price_inr). Since #2749 PR 3 this
    // is the whole-rupee TOTAL the buyer pays, GST included (= total_paise / 100); before it, the
    // list price before GST. The paise columns below are the precise record.
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
    // The provider's payment reference, stamped when the order settles (or is held). Opaque.
    providerPaymentRef: text("provider_payment_ref"),
    // ── THE MONEY, IN PAISE (#2749 item 7, migration 0176) ─────────────────────
    // `gstPriceLine(price)` stamped at order creation: taxable + gst + round_off = total, and the
    // total is a whole rupee. NULL on every pre-0176 order (it carried only `amount_inr`); all
    // five are written together (`payment_orders_money_set_chk`). The settle path compares the
    // captured amount with `total_paise` (or `amount_inr` × 100 on an old row).
    taxablePaise: integer("taxable_paise"),
    gstPaise: integer("gst_paise"),
    roundOffPaise: integer("round_off_paise"),
    totalPaise: integer("total_paise"),
    // The GST rate applied, in basis points (1800 = 18%).
    gstRateBps: integer("gst_rate_bps"),
    // How long the credits last, in days, stamped from the pack at order creation so the settle
    // never re-reads the catalogue (#2749 hazard 8). NULL = the lot never expires.
    creditValidityDays: integer("credit_validity_days"),
    // Where the purchase started (`PAYMENT_ORDER_ORIGINS`), and the job posting it came from —
    // verified to be the buyer tenant's own at order time, else stored null. Both nullable.
    origin: text("origin").$type<PaymentOrderOrigin>(),
    originJobPostingId: uuid("origin_job_posting_id").references(() => jobPostings.id, {
      onDelete: "set null",
    }),
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
    // a resolver bug, and a DB constraint is the only place it cannot be forgotten. Since 0176
    // it binds a `credit_pack` order only (#2751's products may grant no credits).
    check(
      "payment_orders_credits_pos_chk",
      sql`${t.creditsGranted} > 0 OR ${t.productKind} <> 'credit_pack'`,
    ),
    // `PAYMENT_ORDER_STATUSES`, spelled out because a CHECK is static SQL (0176's test pins it).
    check("payment_orders_status_chk", sql`${t.status} IN ('created', 'paid', 'failed', 'held')`),
    // ── 0176 (#2749 item 9) ────────────────────────────────────────────────────
    // `PAYMENT_ORDER_PRODUCT_KINDS`. #2751 widens it.
    check("payment_orders_product_kind_chk", sql`${t.productKind} IN ('credit_pack')`),
    // A credit-pack order names its pack.
    check(
      "payment_orders_pack_code_chk",
      sql`${t.productKind} <> 'credit_pack' OR ${t.packCode} IS NOT NULL`,
    ),
    // The five money columns are written together or not at all (a pre-0176 row has none).
    check(
      "payment_orders_money_set_chk",
      sql`(${t.taxablePaise} IS NULL AND ${t.gstPaise} IS NULL AND ${t.roundOffPaise} IS NULL AND ${t.totalPaise} IS NULL AND ${t.gstRateBps} IS NULL) OR (${t.taxablePaise} IS NOT NULL AND ${t.gstPaise} IS NOT NULL AND ${t.roundOffPaise} IS NOT NULL AND ${t.totalPaise} IS NOT NULL AND ${t.gstRateBps} IS NOT NULL)`,
    ),
    // When set: total = taxable + GST + round-off, a positive whole rupee, equal to the rupee
    // column; the taxable amount and the tax are non-negative; the rate is 0–100%.
    check(
      "payment_orders_money_sum_chk",
      sql`${t.totalPaise} IS NULL OR (${t.totalPaise} = ${t.taxablePaise} + ${t.gstPaise} + ${t.roundOffPaise} AND ${t.totalPaise} > 0 AND ${t.totalPaise} % 100 = 0 AND ${t.totalPaise} = ${t.amountInr} * 100 AND ${t.taxablePaise} >= 0 AND ${t.gstPaise} >= 0 AND ${t.gstRateBps} BETWEEN 0 AND 10000)`,
    ),
    check(
      "payment_orders_validity_pos_chk",
      sql`${t.creditValidityDays} IS NULL OR ${t.creditValidityDays} > 0`,
    ),
    // `PAYMENT_ORDER_ORIGINS`, spelled out (0176's test pins the copy).
    check(
      "payment_orders_origin_chk",
      sql`${t.origin} IS NULL OR ${t.origin} IN ('credits_page', 'unlock_prompt', 'candidate_search', 'posting_flow', 'dashboard', 'other')`,
    ),
    // The FK's referencing side, so a job posting's delete (seeds only today) does not scan.
    index("payment_orders_origin_job_posting_idx")
      .on(t.originJobPostingId)
      .where(sql`${t.originJobPostingId} IS NOT NULL`),
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
