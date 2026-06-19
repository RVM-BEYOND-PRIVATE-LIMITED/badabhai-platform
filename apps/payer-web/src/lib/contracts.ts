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
  status: z.enum(["draft", "open", "closed"]),
  applicantCount: z.number().int().nonnegative(),
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
  /** Banded experience (e.g. "3-5 yrs") — coarse, never an exact figure. */
  experienceBand: z.string(),
  /** Canonical trade/role labels (taxonomy, not free-text employer names). */
  tradeLabel: z.string(),
  /** Coarse city only — never an exact address. */
  cityLabel: z.string(),
  /** Top canonical skills (taxonomy tokens), capped. */
  skills: z.array(z.string()).max(8),
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

/* ── Masked resume reveal ───────────────────────────────────────────────────── */

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

export const maskedResumeResultSchema = z.union([
  maskedResumeSchema,
  maskedResumeNeutralSchema,
]);
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
