import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";

/**
 * Buy a paid plan for a job posting (ADR-0013 Decision B). Price/quota/window are
 * resolved from the pricing catalog at purchase and STAMPED on the row. `payer_id`
 * is the opaque payer (employer OR agent) — no ops auth in alpha (PayerAuthGuard is
 * a launch gate). An optional coupon code is validated fail-closed by the engine.
 */
export const BuyPlanSchema = z.object({
  payer_id: uuidSchema,
  tier: z.enum(["standard", "pro"]),
  coupon: z.string().min(1).max(64).optional(),
});
export type BuyPlanDto = z.infer<typeof BuyPlanSchema>;

/** Buy a booster for a job posting (ADR-0013 Decision B). */
export const BuyBoostSchema = z.object({
  payer_id: uuidSchema,
  tier: z.enum(["all_candidates"]).default("all_candidates"),
  coupon: z.string().min(1).max(64).optional(),
});
export type BuyBoostDto = z.infer<typeof BuyBoostSchema>;

/**
 * Payer self-serve buy-a-plan (B3 / LC-1 fix). IDENTICAL to {@link BuyPlanSchema} EXCEPT
 * it has NO `payer_id`: the payer is the verified SESSION payer (`req.payer.id`), stamped
 * by the service — never a body value (XB-A, the IDOR guarantee). This is the payer-authed
 * analogue of the ops {@link BuyPlanSchema}, mirroring how {@link BuyCapacitySchema} drops
 * `payer_id` for the payer-self capacity buy.
 */
export const PayerBuyPlanSchema = z.object({
  tier: z.enum(["standard", "pro"]),
  coupon: z.string().min(1).max(64).optional(),
});
export type PayerBuyPlanDto = z.infer<typeof PayerBuyPlanSchema>;

/** Payer self-serve buy-a-boost (B3 / LC-1 fix). `payer_id`-free; session-derived (XB-A). */
export const PayerBuyBoostSchema = z.object({
  tier: z.enum(["all_candidates"]).default("all_candidates"),
  coupon: z.string().min(1).max(64).optional(),
});
export type PayerBuyBoostDto = z.infer<typeof PayerBuyBoostSchema>;

/**
 * Buy/upgrade per-payer hiring capacity (ADR-0016). RAISES how many posting plans the
 * payer may hold in status='active' concurrently, then auto-resumes paused plans up to
 * the new allowance. `tier` is a capacity-catalog tier CODE (validated fail-closed by
 * the engine). The `payerId` comes from the route param — ADVISORY in alpha (no per-
 * payer auth; guarded only by InternalServiceGuard, PayerAuthGuard is LC-1, see service).
 * An optional coupon is validated fail-closed by the engine. PII-free.
 */
export const BuyCapacitySchema = z.object({
  tier: z.string().min(1).max(64),
  coupon: z.string().min(1).max(64).optional(),
});
export type BuyCapacityDto = z.infer<typeof BuyCapacitySchema>;

/**
 * Payer self-serve quota top-up (B2). Buys additional applicant-visibility views for one of
 * the caller's OWN active posting plans ("view more → pay more"), resolved through the ONE
 * pricing engine (ADR-0013 — a `quota_topup` catalog product). `tier` is a top-up tier CODE
 * (e.g. `topup_10`), validated fail-closed by the engine. NO `payer_id`: the owner is the
 * verified SESSION payer (`req.payer.id`), stamped by the service (XB-A). Optional coupon is
 * validated fail-closed. PII-free.
 */
export const PayerTopUpQuotaSchema = z.object({
  tier: z.string().min(1).max(64),
  coupon: z.string().min(1).max(64).optional(),
});
export type PayerTopUpQuotaDto = z.infer<typeof PayerTopUpQuotaSchema>;

/**
 * The payer-self read view of a posting's current plan (GET /payer/job-postings/:id/plan).
 * PII-FREE by construction: ids + a catalog tier code + a lifecycle status + integer counts
 * + ISO window timestamps ONLY — never a worker field (no name/phone/worker_id) and never
 * payer PII. It lets the portal show the REAL per-posting applicant-visibility quota (base +
 * top-ups) instead of a `0` placeholder. Read-only — this shape is never persisted; the
 * service maps a {@link import("@badabhai/db").PostingPlan} row into it (snake_case to match
 * the other payer reads, e.g. {@link import("./posting-plans.service").CapacityView}).
 *
 * `plan` is `null` when the posting has no plan yet (ownership is confirmed by the caller
 * BEFORE this read, so a null plan is NOT an enumeration oracle). `effective_quota` is the
 * DERIVED cap the (future) view chokepoint enforces = applicant_visibility_quota (the immutable
 * receipt) + quota_topup_count — computed in the service, never stored.
 */
export const PostingPlanViewSchema = z.object({
  job_posting_id: uuidSchema,
  plan: z
    .object({
      tier: z.enum(["standard", "pro"]),
      status: z.enum(["draft", "active", "expired", "paused"]),
      applicant_visibility_quota: z.number().int().nonnegative(),
      quota_topup_count: z.number().int().nonnegative(),
      effective_quota: z.number().int().nonnegative(),
      applicants_viewed_count: z.number().int().nonnegative(),
      paid_at: z.string().nullable(),
      expires_at: z.string().nullable(),
    })
    .nullable(),
});
export type PostingPlanView = z.infer<typeof PostingPlanViewSchema>;
