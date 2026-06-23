import { z } from "zod";

/**
 * Typed contracts (Zod) for every payer-portal data boundary (invariant #7 / §HARD
 * CONSTRAINTS — typed contracts, no `any`). These mirror the SHAPES the backend
 * payer-scoped endpoints will return; today the backend has NO payer-scoped route
 * group bound to `PayerAuthGuard`, so the data layer (`payer-api.ts`) serves these
 * from a MOCK store. Pinning them here means the swap to the real API is a one-file
 * change with the contracts already enforced.
 *
 * PII RULE (invariant #2 / B-R2): NOTHING in these shapes carries raw worker OR
 * payer PII. Applicants are FACELESS (opaque worker_id, banded, no name/phone/
 * employer). The masked resume carries masked initials + NO phone. `payer_id` is
 * the only payer token.
 */

/* ── Dashboard ──────────────────────────────────────────────────────────────── */

export const postingSummarySchema = z.object({
  id: z.string().uuid(),
  roleTitle: z.string(),
  locationLabel: z.string().nullable(),
  vacancyBand: z.string(),
  status: z.enum(["draft", "open", "closed", "paused"]),
  applicantCount: z.number().int().nonnegative(),
  /**
   * How many applicant profiles this posting may disclose ("view more → pay more").
   * Config-derived (catalog posting-quota tiers, never a hardcoded literal); raised
   * by a TOP-UP. Optional for backward-compat with already-shipped mock rows.
   */
  applicantQuota: z.number().int().nonnegative().optional(),
  createdAt: z.string(),
});
export type PostingSummary = z.infer<typeof postingSummarySchema>;

/** A payer's own credit balance — the one legitimately-knowable signal (no-oracle). */
export const creditBalanceSchema = z.object({
  payerId: z.string().uuid(),
  balance: z.number().int().nonnegative(),
});
export type CreditBalance = z.infer<typeof creditBalanceSchema>;

/** One past unlock by THIS payer (payer-scoped). PII-free routing record only. */
export const unlockHistoryItemSchema = z.object({
  unlockId: z.string().uuid(),
  workerId: z.string().uuid(),
  status: z.enum(["granted", "expired"]),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type UnlockHistoryItem = z.infer<typeof unlockHistoryItemSchema>;

export const dashboardSchema = z.object({
  credits: creditBalanceSchema,
  postings: z.array(postingSummarySchema),
  unlocks: z.array(unlockHistoryItemSchema),
});
export type Dashboard = z.infer<typeof dashboardSchema>;

/* ── Post a job ─────────────────────────────────────────────────────────────── */

/** Vacancy bands mirror packages/db (banded, never a raw headcount). */
export const VACANCY_BANDS = ["1-5", "6-20", "21-50", "50+"] as const;
export const vacancyBandSchema = z.enum(VACANCY_BANDS);
export type VacancyBand = z.infer<typeof vacancyBandSchema>;

export const createPostingInputSchema = z.object({
  roleTitle: z.string().min(2).max(120),
  locationLabel: z.string().max(120).optional(),
  description: z.string().max(2000).optional(),
  vacancyBand: vacancyBandSchema,
});
export type CreatePostingInput = z.infer<typeof createPostingInputSchema>;

/* ── Applicant feed (FACELESS, banded) ──────────────────────────────────────── */

/**
 * One faceless applicant on a posting. NO name/phone/employer/raw-PII — only the
 * opaque worker_id + banded, post-masking signals the API authorizes (XB-C: no
 * existence/consent oracle leaks here either).
 */
export const facelessApplicantSchema = z.object({
  workerId: z.string().uuid(),
  /** Deterministic relevance rank from the RANK core (LIVE: payer reach view). */
  rank: z.number().int().nonnegative(),
  /** Relevance score (LLM-never-decides; deterministic). */
  score: z.number(),
  /** Whether the RANK core flags this candidate hot (LIVE). */
  hot: z.boolean(),
  /**
   * Coarse, PII-free signal reasons (the engine's score-component reasons) — used
   * as faceless relevance chips. Capped. Never employer names / free-text PII.
   */
  signals: z.array(z.string()).max(8),
  /**
   * The banded TAXONOMY labels (trade / experience / city / skills) are NOT in the
   * payer-authed reach projection yet (it returns ranking signals only). They are
   * OPTIONAL here: the mock shim fills them; the LIVE endpoint omits them until the
   * backend adds a faceless taxonomy projection (ESCALATE). PII-free either way.
   */
  experienceBand: z.string().optional(),
  tradeLabel: z.string().optional(),
  cityLabel: z.string().optional(),
  skills: z.array(z.string()).max(8).optional(),
});
export type FacelessApplicant = z.infer<typeof facelessApplicantSchema>;

export const applicantFeedSchema = z.object({
  postingId: z.string().uuid(),
  roleTitle: z.string(),
  applicants: z.array(facelessApplicantSchema),
});
export type ApplicantFeed = z.infer<typeof applicantFeedSchema>;

/* ── Unlock (no-oracle) ─────────────────────────────────────────────────────── */

/** The ONE distinguishable unlock success. Mirrors POST /unlocks granted branch. */
export const unlockGrantedSchema = z.object({
  ok: z.literal(true),
  unlockId: z.string().uuid(),
  status: z.literal("granted"),
  expiresAt: z.string(),
});

/** The byte-identical neutral body shared by every deny branch (XB-C / no-oracle). */
export const unlockNeutralSchema = z.object({ status: z.literal("unavailable") });

export const unlockResultSchema = z.union([unlockGrantedSchema, unlockNeutralSchema]);
export type UnlockResult = z.infer<typeof unlockResultSchema>;

/* ── Reveal → ROUTED contact handle (LIVE: POST /payer/unlocks/:id/reveal) ─────── */

/**
 * The reveal success body — mirrors the backend `ContactRevealedResponse` exactly:
 * an OPAQUE, non-reversible, expiring relay handle ONLY. There is NO phone, NO
 * number, NO name field on this type, so a raw phone is a COMPILE error, not a
 * review miss (ADR-0010 F-4 / the pinned reveal contract: NEVER a raw phone).
 */
export const revealRoutedSchema = z.object({
  relay_handle: z.string(),
  channel: z.enum(["in_app_relay", "proxy_number"]),
  expires_at: z.string(),
});

/** The byte-identical neutral reveal body (no-oracle, F-3) — same as the unlock one. */
export const revealNeutralSchema = z.object({ status: z.literal("unavailable") });

export const revealResultSchema = z.union([revealRoutedSchema, revealNeutralSchema]);
export type RevealResult = z.infer<typeof revealResultSchema>;

/* ── Masked resume reveal (WAITING — no payer-authed endpoint; resume-disclosure
 *    is InternalServiceGuard, ESCALATE). Kept for the clearly-seamed shim. ───────── */

/**
 * The masked employer-facing resume (resume-disclosure addendum B-G / XB-E):
 * masked initials like "R***** K.", NO phone, no raw name. `resumeUrl` is a
 * short-TTL signed URL to the masked PDF — never logged client-side.
 */
export const maskedResumeSchema = z.object({
  ok: z.literal(true),
  disclosureId: z.string().uuid(),
  status: z.literal("disclosed"),
  /** Masked initials only — e.g. "R***** K." NEVER a full name. */
  displayInitials: z.string(),
  /** Short-TTL signed URL to the MASKED PDF. No phone anywhere in the artifact. */
  resumeUrl: z.string().url(),
  expiresAt: z.string(),
});

export const maskedResumeNeutralSchema = z.object({ status: z.literal("unavailable") });

export const maskedResumeResultSchema = z.union([maskedResumeSchema, maskedResumeNeutralSchema]);
export type MaskedResumeResult = z.infer<typeof maskedResumeResultSchema>;

/* ── Credit top-up (MOCK ledger) ────────────────────────────────────────────── */

/** A credit pack offered for purchase — sourced from config, never hardcoded here. */
export const creditPackSchema = z.object({
  code: z.string(),
  priceInr: z.number().int().positive(),
  credits: z.number().int().positive(),
});
export type CreditPack = z.infer<typeof creditPackSchema>;

export const topUpResultSchema = z.object({
  payerId: z.string().uuid(),
  balance: z.number().int().nonnegative(),
  creditsAdded: z.number().int().positive(),
  packCode: z.string(),
  /** Always false in Phase 1 — MOCK ledger only (XT5 / E-R2). */
  realCall: z.literal(false),
});
export type TopUpResult = z.infer<typeof topUpResultSchema>;

/* ── Capacity view (WAITING — no payer-authed endpoint; capacity.controller is
 *    InternalServiceGuard, ESCALATE GET /payer/capacity). PII-free counts only. ──── */

/** One posting's applicant-quota usage row (quota purchased vs profiles disclosed). */
export const postingCapacityRowSchema = z.object({
  postingId: z.string().uuid(),
  roleTitle: z.string(),
  status: z.enum(["draft", "open", "closed", "paused"]),
  vacancyBand: z.string(),
  /** Applicant profiles disclosed so far (config-bounded by quota). */
  applicantsUsed: z.number().int().nonnegative(),
  /** The posting's current applicant quota (config-derived; raised by top-up). */
  applicantQuota: z.number().int().nonnegative(),
});
export type PostingCapacityRow = z.infer<typeof postingCapacityRowSchema>;

/**
 * The payer's CAPACITY usage — concurrent active-vacancy allowance (ADR-0016) plus
 * per-posting applicant-quota usage. All counts; NO raw PII. `activeVacancyAllowance`
 * is config-derived (catalog capacity tier), never a hardcoded headcount.
 */
export const capacitySchema = z.object({
  payerId: z.string().uuid(),
  /** Postings currently in an active (non-closed/paused) state. */
  activeVacancies: z.number().int().nonnegative(),
  /** Config-derived concurrent active-vacancy allowance (baseline capacity tier). */
  activeVacancyAllowance: z.number().int().nonnegative(),
  /** Total applicant quota purchased across all postings (sum of per-posting quota). */
  applicantQuotaTotal: z.number().int().nonnegative(),
  /** Total applicant profiles disclosed across all postings. */
  applicantQuotaUsed: z.number().int().nonnegative(),
  postings: z.array(postingCapacityRowSchema),
});
export type Capacity = z.infer<typeof capacitySchema>;

/* ── REAL backend wire shapes (LIVE payer-authed endpoints) ─────────────────────
 *
 * These mirror the EXACT JSON the NestJS payer-authed controllers return (read off
 * their DTOs). The backend uses snake_case for the unlock/credits/reach group and
 * camelCase for GET /payer/me. The data seam (`payer-api.ts`) parses with THESE,
 * then maps onto the UI contracts above so pages stay decoupled from the wire.
 * NONE of these carry raw worker/payer PII (invariant #2 / B-R2).
 */

/** GET /payer/me — the payer's OWN account (their own org label; never eventized). */
export const payerMeWireSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(["employer", "agent"]),
  status: z.enum(["pending", "active", "suspended"]),
  orgName: z.string(),
});
export type PayerMeWire = z.infer<typeof payerMeWireSchema>;

/**
 * The agency's OWN account identity for the dashboard identity card (mapped from
 * GET /payer/me). Carries ONLY the agency's own non-PII fields — role, account
 * status, and the org's own display label. NEVER a worker name/phone (faceless).
 */
export const agencyAccountSchema = z.object({
  role: z.enum(["employer", "agent"]),
  status: z.enum(["pending", "active", "suspended"]),
  displayLabel: z.string(),
});
export type AgencyAccount = z.infer<typeof agencyAccountSchema>;

/** GET /payer/credits — `{ payer_id, balance }`. */
export const creditsWireSchema = z.object({
  payer_id: z.string().uuid(),
  balance: z.number().int().nonnegative(),
});

/** GET /payer/unlocks — `{ unlocks: UnlockProjection[] }` (PII-free projection). */
export const unlockProjectionWireSchema = z.object({
  unlock_id: z.string().uuid(),
  payer_id: z.string().uuid(),
  worker_id: z.string().uuid(),
  job_id: z.string().uuid().nullable(),
  status: z.enum(["granted", "revealed", "expired", "revoked"]),
  reveal_count: z.number().int().nonnegative(),
  granted_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  created_at: z.string(),
});
export const unlocksListWireSchema = z.object({
  unlocks: z.array(unlockProjectionWireSchema),
});

/** POST /payer/unlocks — the ONE distinguishable success, snake_case. */
export const unlockGrantedWireSchema = z.object({
  ok: z.literal(true),
  unlock_id: z.string().uuid(),
  status: z.literal("granted"),
  expires_at: z.string(),
});
export const neutralWireSchema = z.object({ status: z.literal("unavailable") });
export const unlockResultWireSchema = z.union([unlockGrantedWireSchema, neutralWireSchema]);

/**
 * POST /payer/credits — buy a credit pack (LIVE, @HttpCode(201)). The request body
 * carries ONLY the pack CODE (XB-A: no payer_id, no price, no credits — the server
 * resolves price + credits from config). The response mirrors
 * {@link import("../../api/src/unlocks/unlocks.service").UnlockService.purchaseCredits}:
 * `{ payer_id, balance, credits, pack_code }`. Money is MOCK (real_call:false; there is
 * NO Razorpay) — an unknown pack is a real 404 (catalog item, not a tenant oracle).
 */
export const buyPackResultWireSchema = z.object({
  payer_id: z.string().uuid(),
  balance: z.number().int().nonnegative(),
  credits: z.number().int().positive(),
  pack_code: z.string(),
});

/**
 * GET /payer/capacity — the caller's OWN hiring-capacity allowance (LIVE, Bearer only).
 * Mirrors {@link import("../../api/src/posting-plans/posting-plans.service").PostingPlansService.getCapacity}:
 * `{ payer_id, max_active_vacancies, source_tier, expires_at }`. Counts/codes only; NO
 * raw worker/payer PII. `source_tier`/`expires_at` are null until a capacity pack is bought.
 */
export const payerCapacityWireSchema = z.object({
  payer_id: z.string().uuid(),
  max_active_vacancies: z.number().int().nonnegative(),
  source_tier: z.string().nullable(),
  expires_at: z.string().nullable(),
});

/**
 * GET /payer/reach/jobs/:jobId/applicants — faceless ranked rows (no PII).
 *
 * The backend reach projection (ApplicantRowDto) now also returns coarse, PII-free
 * banded taxonomy chips (`experienceBand` / `tradeLabel` / `cityLabel`) derived from
 * the worker's signal columns — opaque labels/bands only, never a name/phone/employer/
 * exact location. They are nullable+optional here so an older backend (or a worker with
 * no signal) parses fine; the seam maps `null -> undefined` onto the optional
 * {@link facelessApplicantSchema} band fields. `skills` is intentionally not in this
 * projection yet (stays optional on the UI type).
 */
export const reachApplicantWireSchema = z.object({
  workerId: z.string().uuid(),
  rank: z.number().int(),
  score: z.number(),
  hot: z.boolean(),
  pushEligible: z.boolean(),
  components: z.array(z.unknown()),
  experienceBand: z.string().nullable().optional(),
  tradeLabel: z.string().nullable().optional(),
  cityLabel: z.string().nullable().optional(),
});
export const reachApplicantListWireSchema = z.object({
  jobId: z.string().uuid(),
  applicants: z.array(reachApplicantWireSchema),
});

/* ── @parked Phase-2 SUPPLY contract shells (TYPE-ONLY) ──────────────────────────
 *
 * @parked Phase-2 — agency SUPPLY (referrals / payouts / KYC) is CEO-gated and NOT
 * built in Phase 1 (CLAUDE.md §8 deferred; D2/D3). These are TYPE shells ONLY: there
 * is NO seam fn, NO endpoint, NO mock data, and NO function that returns them. They
 * exist so the eventual build pins shapes in one place. KYC is a HIGH-sensitivity PII
 * surface — building anything here pulls a parked, backend-heavy slice forward.
 */

/** @parked Phase-2 — an agency referral link. No seam fn, no endpoint. */
export interface ReferralLink {
  referralId: string;
  code: string;
  createdAt: string;
  status: "active" | "disabled";
}

/** @parked Phase-2 — one payout-ledger row (real money out). No seam fn, no endpoint. */
export interface PayoutLedgerRow {
  payoutId: string;
  amountInr: number;
  status: "pending" | "approved" | "paid" | "rejected";
  createdAt: string;
}

/** @parked Phase-2 — agency KYC status (HIGH-sensitivity PII). No seam fn, no endpoint. */
export interface KycStatus {
  state: "not_started" | "submitted" | "verified" | "rejected";
  updatedAt: string | null;
}
