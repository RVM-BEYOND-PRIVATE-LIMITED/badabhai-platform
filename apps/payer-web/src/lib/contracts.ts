import { z } from "zod";
import { looksLikePii } from "@badabhai/validators";

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

/* ── Shared DEMAND primitives (employer postings + agency jobs) ──────────────────
 *
 * The trade enum and the C10 numeric ceilings are now used by BOTH demand surfaces —
 * the employer posting form ({@link createPostingInputSchema}) and the agency job form
 * ({@link agencyJobInputSchema}) — so they live here as one shared source. The trade
 * keys are the SAME manufacturing-alpha enum the backend `agency.dto.ts` accepts
 * (`REQUIRED_TRADE_KEYS`); an out-of-set value is rejected at the form boundary AND by
 * the backend Zod enum, so a job/posting can never carry an arbitrary string.
 */
export const TRADE_KEYS = [
  "cnc_operator",
  "vmc_operator",
  "cnc_vmc_setter",
  "cnc_programmer",
  "vmc_programmer",
  "cad_designer",
  "solidworks_designer",
  "autocad_draftsman",
  "quality_inspector",
  "production_engineer",
  "maintenance_technician",
  "tool_room_technician",
  "machine_operator",
  "assembly_technician",
  "fitter",
] as const;
export const tradeKeySchema = z.enum(TRADE_KEYS);
export type TradeKey = z.infer<typeof tradeKeySchema>;

// Numeric ceilings (C10 — anti-abuse / overflow guards, NOT business rules). MUST stay in
// parity with the backend `agency.dto.ts` consts PAY_MAX_INR / EXPERIENCE_MAX_YEARS —
// same VALUES (backend⇄frontend contract parity).
const PAY_MAX_INR = 10_000_000; // ₹/month sanity ceiling (₹1 crore)
const EXPERIENCE_MAX_YEARS = 60; // a plausible career length ceiling

/* ── Post a job ─────────────────────────────────────────────────────────────── */

/**
 * Vacancy bands mirror packages/db (banded, never a raw headcount). NOTE: this FRONTEND
 * band-set is DISTINCT from the backend `@badabhai/types` VACANCY_BANDS (1 / 2-5 / 6-10 /
 * 11-25 / 25+). It is used ONLY for local applicant-quota stamping (pricing-config); the
 * live POST /payer/job-postings receives a raw `vacancies` count and derives its OWN band.
 */
export const VACANCY_BANDS = ["1-5", "6-20", "21-50", "50+"] as const;
export const vacancyBandSchema = z.enum(VACANCY_BANDS);
export type VacancyBand = z.infer<typeof vacancyBandSchema>;

/**
 * Create-posting input for the EMPLOYER self-serve form — brought to DEMAND-schema parity
 * with the agency job form ({@link agencyJobInputSchema}): a trade enum, ordered C10-bounded
 * ₹ pay bands, ordered bounded experience years, plus the kept role/location/description.
 *
 * Vacancy is a RAW integer (`vacancies`) — the PRIMARY input. The frontend derives a local
 * band (pricing-config `bandForVacancies`) ONLY to stamp the applicant quota; the live
 * endpoint receives the raw count and derives its OWN band server-side (the two band-sets
 * differ — see {@link VACANCY_BANDS}). The server Zod (backend `PayerCreateJobPostingSchema`)
 * + this schema in the action stay the AUTHORITY; the form mirrors it for inline UX (C9).
 *
 * PII (invariant #2 / D3 defense-in-depth): `description` is the only free-text field, so it
 * is the only one screened for an OBVIOUS phone/email via `looksLikePii` (shared with the
 * backend). trade/role/location are short labels (machine codes/pincodes are legit) — not
 * screened. There is deliberately NO employer-name field (the payer's own org is the session
 * identity, stamped server-side — never typed here).
 */
export const createPostingInputSchema = z
  .object({
    tradeKey: tradeKeySchema,
    roleTitle: z.string().min(2).max(120),
    locationLabel: z.string().max(120).optional(),
    description: z
      .string()
      .min(1)
      .max(2000)
      .refine((s) => !looksLikePii(s), {
        message: "Remove contact details (phone/email) from the description.",
      })
      .optional(),
    // Raw vacancy count — INTAKE ONLY. Mirrors the backend `vacancies` field (positive int);
    // the band is derived from it (locally for quota, server-side for the stored band).
    vacancies: z.number().int().positive(),
    payMin: z.number().int().nonnegative().max(PAY_MAX_INR).optional(),
    payMax: z.number().int().nonnegative().max(PAY_MAX_INR).optional(),
    minExperienceYears: z.number().int().nonnegative().max(EXPERIENCE_MAX_YEARS).optional(),
    maxExperienceYears: z.number().int().nonnegative().max(EXPERIENCE_MAX_YEARS).optional(),
  })
  .refine((o) => o.payMin === undefined || o.payMax === undefined || o.payMax >= o.payMin, {
    message: "Max pay must be greater than or equal to min pay.",
    path: ["payMax"],
  })
  .refine(
    (o) =>
      o.minExperienceYears === undefined ||
      o.maxExperienceYears === undefined ||
      o.maxExperienceYears >= o.minExperienceYears,
    {
      message: "Max experience must be greater than or equal to min experience.",
      path: ["maxExperienceYears"],
    },
  );
export type CreatePostingInput = z.infer<typeof createPostingInputSchema>;

/**
 * The EDITABLE subset of a posting — exactly the fields the LIVE
 * `PATCH /payer/job-postings/:id` body carries (role_title / vacancies /
 * location_label? / description?; see `toPayerJobPostingPatchBody`). A structural
 * subset of {@link CreatePostingInput}, so create-form inputs satisfy it unchanged.
 */
export const updatePostingInputSchema = z.object({
  // max 200 (NOT the create form's 120): the backend PATCH accepts up to 200, and an
  // ops-created posting with a 121–200-char title must stay saveable in the edit form.
  roleTitle: z.string().min(2).max(200),
  /**
   * OPTIONAL: omitted when the user did not touch the count, so an edit of another
   * field can NEVER silently re-derive (and possibly downgrade) the stored vacancy
   * band — the backend re-bands ONLY when a count is actually submitted.
   */
  vacancies: z.number().int().positive().optional(),
  locationLabel: z.string().max(120).optional(),
  description: z
    .string()
    .min(1)
    .max(2000)
    .refine((s) => !looksLikePii(s), {
      message: "Remove contact details (phone/email) from the description.",
    })
    .optional(),
});
export type UpdatePostingInput = z.infer<typeof updatePostingInputSchema>;

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

/* ── Masked resume reveal (LIVE — the payer-authed POST /payer/resume-disclosures;
 *    see maskedResumeWireSchema below for the exact wire union). ────────────────── */

/**
 * The masked employer-facing resume (resume-disclosure addendum B-G / XB-E):
 * masked initials like "R***** K.", NO phone, no raw name. `resumeUrl` is a
 * short-TTL signed URL to the masked PDF — never logged client-side.
 */
export const maskedResumeSchema = z.object({
  ok: z.literal(true),
  disclosureId: z.string().uuid(),
  status: z.literal("disclosed"),
  /**
   * Masked initials only — e.g. "R***** K." NEVER a full name. OPTIONAL: the LIVE
   * disclosure response carries no initials field (the masking lives inside the PDF
   * artifact itself); the card renders a neutral label when absent.
   */
  displayInitials: z.string().optional(),
  /** Short-TTL signed URL to the MASKED PDF. No phone anywhere in the artifact. */
  resumeUrl: z.string().url(),
  expiresAt: z.string(),
});

export const maskedResumeNeutralSchema = z.object({ status: z.literal("unavailable") });

export const maskedResumeResultSchema = z.union([maskedResumeSchema, maskedResumeNeutralSchema]);
export type MaskedResumeResult = z.infer<typeof maskedResumeResultSchema>;

/**
 * LIVE wire of `POST /payer/resume-disclosures` (payer-authed; XB-A — the body carries
 * only worker_id + job_posting_id, never a payer_id). EXACTLY the backend
 * `DisclosureGrantedResponse` | the byte-identical neutral body (B-C no-oracle): every
 * deny cause (no consent / capped / unknown / no resume) is the SAME `unavailable`.
 * PII-free: an opaque id + a short-TTL signed URL — no name, no phone, no deny reason.
 */
export const maskedResumeWireSchema = z.union([
  z.object({
    ok: z.literal(true),
    disclosure_id: z.string().uuid(),
    status: z.literal("disclosed"),
    // Rendered as an <a href> — fail CLOSED on a non-https scheme (javascript:/data:)
    // so the no-XSS property is structural, not backend trust. http://localhost is
    // allowed for local dev (a local Supabase signed URL).
    resume_url: z
      .string()
      .url()
      .refine((u) => u.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u), {
        message: "resume_url must be https (or localhost in dev)",
      }),
    expires_at: z.string(),
  }),
  z.object({ status: z.literal("unavailable") }),
]);

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

/**
 * One top-up record for the caller's OWN credit history (ADR-0019 Phase 1). NOW LIVE:
 * derived from the authoritative `GET /payer/credits/ledger` rows (positive pack
 * movements), the source of the 12-month expiry schedule. PII-FREE by construction:
 * ids + amounts + a config pack code only — NEVER a worker name/phone. `priceInr` is
 * resolved from the @badabhai/pricing catalog (never a client/hardcoded amount, XT5).
 */
export const creditTopUpSchema = z.object({
  topUpId: z.string().uuid(),
  packCode: z.string(),
  credits: z.number().int().positive(),
  /**
   * What this purchase ACTUALLY cost — the ₹ STAMPED on the ledger row at purchase time
   * (D-6). ABSENT for legacy rows written before the stamp existed; the page then renders
   * a dash. It is NEVER back-filled from the CURRENT catalog: doing so let an ops price
   * edit retroactively rewrite what past purchases appear to have cost.
   */
  priceInr: z.number().int().nonnegative().optional(),
  createdAt: z.string(),
});
export type CreditTopUp = z.infer<typeof creditTopUpSchema>;

/**
 * LIVE wire of `GET /payer/credits/ledger` (payer-authed; XB-A — the ledger is the
 * SESSION payer's own movements, `limit` bounded server-side at 1..50). EXACTLY the
 * backend `{ payer_id, ledger: CreditLedgerItem[] }` projection: amounts + opaque ids
 * + a closed reason set only — PII-free by table design. `reason` is passed through as
 * a string (a closed backend enum; the page renders known labels + a fallback).
 */
export const creditLedgerEntryWireSchema = z.object({
  id: z.string().uuid(),
  delta: z.number().int(),
  reason: z.string(),
  unlock_id: z.string().uuid().nullable(),
  pack_code: z.string().nullable(),
  payment_ref: z.string().nullable(),
  /**
   * The ₹ amount STAMPED at purchase time (D-6). Null for movements with no amount
   * (debits/ops grants) AND for rows written before the column existed. `.nullish()` +
   * default null: an API that predates the column omits the key entirely, and this read
   * must not hard-fail against it (forward/backward compatible, invariant #8).
   */
  price_inr: z.number().int().nonnegative().nullish().default(null),
  created_at: z.string(),
});
export const creditLedgerWireSchema = z.object({
  payer_id: z.string().uuid(),
  ledger: z.array(creditLedgerEntryWireSchema),
});

/**
 * LIVE wire of `POST /payer/job-postings/:id/quota-topup` (B2 #180): the topped-up plan
 * + the engine quote. Parsed loosely — the seam only needs the call to succeed (the page
 * re-reads the posting row); plan/quote internals stay server-side concepts. PII-free.
 */
export const quotaTopUpWireSchema = z.object({
  plan: z.record(z.string(), z.unknown()),
  quote: z.record(z.string(), z.unknown()),
});

/* ── Capacity view (LIVE — GET /payer/capacity under PayerAuthGuard). PII-free
 *    counts only. ─────────────────────────────────────────────────────────────── */

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

/**
 * GET /payer/me — the payer's OWN account (their own org label + email + masked phone;
 * their own data, never eventized). Mirrors the backend `PayerMeSchema` (PROF-1). `email`
 * and `phoneLast4` are `.optional()` here so the consumer stays backward-compatible during
 * rollout (an older response without them still parses); the live backend always sends them.
 */
export const payerMeWireSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(["employer", "agent"]),
  status: z.enum(["pending", "active", "suspended"]),
  orgName: z.string(),
  email: z.string().email().optional(),
  phoneLast4: z.string().length(4).nullable().optional(),
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
  // NULLABLE post-ADR-0026 Phase 5: a worker hard-delete (DSAR) SET-NULLs the identity
  // join — a non-nullable uuid here made the WHOLE unlock history fail parse after any
  // deletion. Null rows are skipped in getUnlocks (the candidate no longer exists).
  worker_id: z.string().uuid().nullable(),
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
 * Mirrors {@link import("../../api/src/posting-plans/posting-plans.service").CapacityView}:
 * `{ payer_id, max_active_vacancies, active_plan_count, source_tier, expires_at }`.
 * Counts/codes only; NO raw worker/payer PII. `active_plan_count` is the REAL, derived
 * live count of the SESSION payer's active plans from the enforcement engine (XB-A:
 * `@CurrentPayer()`, never a body/param id) — the authoritative at-capacity signal.
 * `source_tier`/`expires_at` are null until a capacity pack is bought.
 */
export const payerCapacityWireSchema = z.object({
  payer_id: z.string().uuid(),
  max_active_vacancies: z.number().int().nonnegative(),
  /** REAL active-plan count from the enforcement engine (vs the seeded-mock posting rows). */
  active_plan_count: z.number().int().nonnegative(),
  source_tier: z.string().nullable(),
  expires_at: z.string().nullable(),
});

/**
 * POST /payer/capacity — buy/upgrade the caller's OWN capacity (LIVE, Bearer only, XB-A).
 * Mirrors {@link import("../../api/src/posting-plans/posting-plans.service").BuyCapacityResult}:
 * `{ payer_id, quote, max_active_vacancies, source_tier, expires_at, resumed_plan_ids }`.
 *
 * The request body carries ONLY the tier CODE (XT5: the client NEVER sends a price/amount/
 * quota — the server prices it via the pricing engine; XB-A: NO payer_id — the session token
 * is the identity). `quote` is the server-priced receipt (parsed permissively as it is NOT
 * surfaced to the UI — only `resumed_plan_ids` / `max_active_vacancies` / `source_tier` /
 * `expires_at` are mapped onto a typed result). Counts/codes/timestamps + an opaque id list;
 * NO raw worker/payer PII by construction.
 */
export const buyCapacityWireSchema = z.object({
  payer_id: z.string().uuid(),
  /** Server-priced receipt. NOT surfaced to the UI (XT5) — parsed permissively, never echoed. */
  quote: z.unknown(),
  max_active_vacancies: z.number().int().nonnegative(),
  source_tier: z.string().nullable(),
  expires_at: z.string().nullable(),
  /** Opaque plan ids auto-resumed paused→active under the new allowance. */
  resumed_plan_ids: z.array(z.string()),
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

/**
 * GET/POST/PATCH /payer/job-postings(/:id) — the EMPLOYER self-serve posting row, exactly
 * the `JobPosting` Drizzle row the payer-authed {@link
 * import("../../api/src/payer-portal/payer-job-postings.controller").PayerJobPostingsController}
 * returns (camelCase keys; `Date` columns serialize to ISO strings → `z.string()`). Status is
 * the FULL four-state backend lifecycle `draft|open|paused|closed` (`paused` landed with the
 * payer pause/resume routes, #178).
 *
 * PII NOTE (invariant #2 / B-R2): this WIRE shape carries the payer's OWN identity fields
 * (`payerId`/`createdBy` — the session payer's own id) plus the payer's OWN `orgLabel` +
 * free-text `description`. Those are the PAYER's own data (the org they registered + the blurb
 * they typed), NEVER worker PII — but they are NOT needed by any page, so the seam's wire→domain
 * mapper DROPS them: only the faceless {@link postingSummarySchema} fields reach the UI. No raw
 * worker PII exists on this row by construction (applicants are a separate faceless reach feed).
 */
export const jobPostingWireSchema = z.object({
  id: z.string().uuid(),
  payerId: z.string().uuid().nullable(),
  createdBy: z.string().uuid(),
  orgLabel: z.string(),
  roleTitle: z.string(),
  locationLabel: z.string().nullable(),
  description: z.string().nullable(),
  // The BACKEND vacancy band-set ('1'/'2-5'/'6-10'/'11-25'/'25+') — distinct from the FRONTEND
  // {@link VACANCY_BANDS}; `postingSummarySchema.vacancyBand` is a plain string so it passes through.
  vacancyBand: z.string(),
  // `paused` landed with the payer pause/resume lifecycle (#178) — the live wire can return it.
  status: z.enum(["draft", "open", "closed", "paused"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
});
export type JobPostingWire = z.infer<typeof jobPostingWireSchema>;
export const jobPostingListWireSchema = z.array(jobPostingWireSchema);

/* ── Agency Supply Portal — DEMAND on the faceless `jobs` entity (ADR-0022) ──────
 *
 * LIVE agency-role (payers.role='agent') wire shapes for the agency's OWN jobs +
 * invite funnel, mirroring `apps/api/src/agency/agency.dto.ts` + `AgencyService`. Every
 * shape is COARSE + non-PII: a trade enum, generic labels, integer ₹ bands, year counts,
 * a coarse timing enum, and counts. There is NEVER an employer name, an address, or any
 * worker identity by construction. `payer_id` is NEVER a field — tenancy is the SESSION
 * (XB-A), stamped server-side. Distinct from the @parked SUPPLY shells below (payouts/KYC).
 */

/** Coarse timing enum — mirrors db.JobNeededBy / the agency DTO. */
export const NEEDED_BY = ["immediate", "soon", "flexible"] as const;
export const neededBySchema = z.enum(NEEDED_BY);
export type NeededBy = z.infer<typeof neededBySchema>;

/**
 * One faceless agency job — the EXACT camelCase projection `AgencyService.toJobView`
 * returns (`Date` fields serialize to ISO strings over the wire → `z.string()`). Status
 * is `open|closed` ONLY (Phase-1 `JobStatus`; pause == close). NO `payer_id` — the owner
 * is never returned (XB-A). NO worker identity by construction.
 */
export const agencyJobWireSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["open", "closed"]),
  tradeKey: z.string(),
  title: z.string(),
  city: z.string(),
  area: z.string().nullable(),
  payMin: z.number().int().nullable(),
  payMax: z.number().int().nullable(),
  minExperienceYears: z.number().int().nullable(),
  maxExperienceYears: z.number().int().nullable(),
  neededBy: neededBySchema.nullable(),
  applicantsReceived: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgencyJob = z.infer<typeof agencyJobWireSchema>;
export const agencyJobListWireSchema = z.array(agencyJobWireSchema);

/**
 * Create/edit input for an agency job — the COARSE, non-PII demand fields ONLY. There is
 * deliberately NO employer-name field (ADR-0009 §2 / ADR-0022 privacy line). Mirrors the
 * backend `CreateAgencyJobSchema` (camelCase here; mapped to snake_case at the seam).
 */
export const agencyJobInputSchema = z
  .object({
    tradeKey: tradeKeySchema,
    title: z.string().min(1).max(200),
    city: z.string().min(1).max(120),
    area: z.string().min(1).max(120).optional(),
    payMin: z.number().int().nonnegative().max(PAY_MAX_INR).optional(),
    payMax: z.number().int().nonnegative().max(PAY_MAX_INR).optional(),
    minExperienceYears: z.number().int().nonnegative().max(EXPERIENCE_MAX_YEARS).optional(),
    maxExperienceYears: z.number().int().nonnegative().max(EXPERIENCE_MAX_YEARS).optional(),
    neededBy: neededBySchema.optional(),
  })
  .refine((o) => o.payMin === undefined || o.payMax === undefined || o.payMax >= o.payMin, {
    message: "Max pay must be greater than or equal to min pay.",
    path: ["payMax"],
  })
  .refine(
    (o) =>
      o.minExperienceYears === undefined ||
      o.maxExperienceYears === undefined ||
      o.maxExperienceYears >= o.minExperienceYears,
    {
      message: "Max experience must be greater than or equal to min experience.",
      path: ["maxExperienceYears"],
    },
  );
export type AgencyJobInput = z.infer<typeof agencyJobInputSchema>;

/**
 * GET /payer/agency/referrals/summary — AGGREGATE-ONLY funnel counts with a k-anon floor
 * ALREADY applied server-side: any stage count strictly below `minBucket` is returned as
 * 0 (suppressed). A 0 therefore means "below the floor", NOT literally zero — the UI
 * surfaces it as "<minBucket" so a single named invitee's consent can never be inferred
 * (no oracle). NO per-invitee / per-worker rows ever (ADR-0022 C.1 #2).
 */
export const agencyReferralsSummaryWireSchema = z.object({
  created: z.number().int().nonnegative(),
  clicked: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  minBucket: z.number().int().positive(),
});
export type AgencyReferralsSummary = z.infer<typeof agencyReferralsSummaryWireSchema>;

/**
 * POST /payer/agency/invites — returns an OPAQUE code only (faceless: the mint takes no
 * phone/name/email/worker-id, only an optional non-PII campaign tag). The agency shows
 * the code/link to copy & share; it never types a contact.
 */
export const agencyInviteWireSchema = z.object({
  agency_invite_id: z.string().uuid(),
  code: z.string(),
  link: z.string(),
});
export type AgencyInvite = z.infer<typeof agencyInviteWireSchema>;

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
