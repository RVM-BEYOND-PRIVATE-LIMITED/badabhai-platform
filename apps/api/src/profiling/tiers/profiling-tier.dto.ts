import { z } from "zod";

import { PROFILING_TIERS } from "@badabhai/types";

import { TRADE_FORM_KINDS } from "../trade-form-router";

/**
 * TIERED PROFILING — the wire contract of `GET /profiling/form/tiers` and
 * `POST /profiling/form/tier` (the tier screen and "add more detail").
 *
 * DATA, NOT COPY. The card titles, the "BadaBhai Standard" badge and the Hindi strings are the
 * app's; the server serves what only it knows — whether the worker must choose, his current tier,
 * and each tier's minutes for his role. The estimates are never hard-coded on the client.
 */

const TierSchema = z.enum(PROFILING_TIERS);

export const TierEstimateSchema = z.object({
  tier: TierSchema,
  /** "About {min}–{max} min" — computed per role, see `profiling-tier-estimates.ts`. */
  min_minutes: z.number().int().positive(),
  max_minutes: z.number().int().positive(),
  /** The asks the estimate was computed from (trade questions + shared page asks). */
  question_count: z.number().int().nonnegative(),
});

export const TierStateResponse = z.object({
  /**
   * `PROFILING_TIERS_ENABLED`. False: go straight to today's full form — every other field is
   * then empty, and the client must not show a tier screen.
   */
  enabled: z.boolean(),
  kind: z.enum(TRADE_FORM_KINDS),
  /** Show the tier screen before the first form question. */
  needs_choice: z.boolean(),
  /** The tier the form asks at; null only while `needs_choice` is true. */
  current_tier: TierSchema.nullable(),
  /** Tiers above the current one — what "Add more detail" can offer. Empty at Hard. */
  upgradable_to: z.array(TierSchema),
  /** Easy, Medium, Hard, in that order. */
  tiers: z.array(TierEstimateSchema),
});
export type TierStateResponse = z.infer<typeof TierStateResponse>;

/** One tap on a tier card. A lower tier than the one held is a 409 — tiers are only raised. */
export const ChooseTierSchema = z.object({ tier: TierSchema }).strict();
export type ChooseTierDto = z.infer<typeof ChooseTierSchema>;

export const ChooseTierResponse = z.object({
  tier: TierSchema,
  previous_tier: TierSchema.nullable(),
  /**
   * `selected` — the first choice. `upgraded` — raised; fetch `GET /profiling/form?view=upgrade`
   * for only the questions still unanswered. `unchanged` — the same tier again (a retried tap).
   */
  change: z.enum(["selected", "upgraded", "unchanged"]),
});
export type ChooseTierResponse = z.infer<typeof ChooseTierResponse>;

/**
 * `GET /profiling/form?view=…` — `upgrade` serves only the unanswered questions in range.
 *
 * NOT `.strict()`: before this parameter existed the route ignored every query parameter, and a
 * client (or a cache-buster) sending one must not start getting a 400. Unknown keys are dropped,
 * and an unknown `view` reads as `full`.
 */
export const TradeFormViewQuery = z.object({
  // An unrecognised value falls back to the full form rather than failing the request.
  view: z.enum(["full", "upgrade"]).catch("full"),
});
export type TradeFormViewQuery = z.infer<typeof TradeFormViewQuery>;
