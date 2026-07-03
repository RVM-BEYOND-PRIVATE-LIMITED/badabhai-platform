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
