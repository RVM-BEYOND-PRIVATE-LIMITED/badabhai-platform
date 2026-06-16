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
