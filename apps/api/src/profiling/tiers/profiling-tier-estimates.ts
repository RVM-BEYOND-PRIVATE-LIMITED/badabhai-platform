/**
 * TIME ESTIMATES FOR THE TIER SCREEN — "About 2–3 min", per role × tier. Config plus pure math.
 *
 * THE DEFAULT IS COMPUTED, NOT AUTHORED: (trade questions the tier asks + the shared page asks)
 * × a seconds-per-question constant, widened into a range and clamped near the product bands
 * (Easy 2–3, Medium 5–7, Hard 10–12). The trade question count comes from the LIVE pack and its
 * tags, so a pack that gains a question moves its own estimate. `tier-tagging.md` §5 shows every
 * role's numbers and why the clamp is load-bearing until real durations exist.
 *
 * A PER-ROLE OVERRIDE wins over the computed default, and an OBSERVED MEDIAN (once the
 * `profile.tier_completed` events carry enough durations) wins over both — see
 * `ProfilingTierService.estimatesFor`.
 */
import type { AnswerRecord, QuestionPackItem } from "@badabhai/ai-contracts";
import { PROFILING_TIERS, type ProfilingTier, type TradeFormKindName } from "@badabhai/types";

import type { AnswerMap } from "../answer-map";
import { isFormQuestionVisible } from "../form/form-eligibility";
import { itemsForTier, type ItemTierMap } from "./profiling-tier.policy";

export interface MinutesRange {
  readonly min_minutes: number;
  readonly max_minutes: number;
}

export const TIER_ESTIMATE_CONFIG = {
  /** One ask — read (or hear) a question, tap an answer. The single tunable. */
  secondsPerQuestion: 20,
  /**
   * The shared page asks each tier adds on top of the trade questions (every role has them).
   * Easy: salary, locations + relocation, shift + job type, accommodation, availability, current
   * job, education, languages. Medium adds the current job's description, one previous job and
   * its description, certificates and documents. Hard adds no page field.
   */
  sharedPageAsks: { easy: 8, medium: 13, hard: 13 } satisfies Record<ProfilingTier, number>,
  /** The product bands the defaults are clamped near (`BADABHAI_PROFILING_TIERS_PROMPT.md` §3). */
  bands: {
    easy: [2, 3],
    medium: [5, 7],
    hard: [10, 12],
  } satisfies Record<ProfilingTier, readonly [number, number]>,
  /** ± around the computed centre before rounding. */
  spread: 0.15,
  /** The upper end may sit this many minutes above its band ("close to", not "inside"). */
  upperHeadroomMinutes: 1,
  /**
   * PER-ROLE OVERRIDES, which win over the computed default. Empty until a role's measured
   * reality says the model is wrong for it.
   */
  overrides: {} as Partial<Record<TradeFormKindName, Partial<Record<ProfilingTier, MinutesRange>>>>,
} as const;

/**
 * Minutes for `questionCount` asks at `tier`, clamped near the tier's band.
 *
 * The LOWER end is clamped INTO the band; the UPPER end may sit `upperHeadroomMinutes` above it.
 * So a role that computes long still reads long ("3–4") rather than being forced into a promise
 * it cannot keep, and one that computes short is never shown less than the band's floor.
 */
export function estimateMinutes(
  questionCount: number,
  tier: ProfilingTier,
  config: typeof TIER_ESTIMATE_CONFIG = TIER_ESTIMATE_CONFIG,
): MinutesRange {
  const raw = (questionCount * config.secondsPerQuestion) / 60;
  let lo = Math.round(raw * (1 - config.spread));
  let hi = Math.round(raw * (1 + config.spread));
  if (hi <= lo) hi = lo + 1;
  const [bandMin, bandMax] = config.bands[tier];
  lo = Math.min(Math.max(lo, bandMin), bandMax);
  hi = Math.min(Math.max(hi, bandMin + 1), bandMax + config.upperHeadroomMinutes);
  if (hi <= lo) hi = lo + 1;
  return { min_minutes: lo, max_minutes: hi };
}

/**
 * How many TRADE questions `tier` asks on the SENIOR path — the longest one.
 *
 * The experience gate is set to its top rung, so every depth question a senior sees is counted
 * and the fresher-only items drop out; the gate itself is not counted because the chat's
 * `experience_years` normally settles it before the form opens (#1459). Other mandatory items
 * (CAM's `programming_mode`) are counted — they are real asks.
 */
export function seniorPathQuestionCount(
  items: readonly QuestionPackItem[],
  tiers: ItemTierMap,
  tier: ProfilingTier,
  tenureKey: string | undefined,
): number {
  const tenureItem = tenureKey ? items.find((item) => item.question_key === tenureKey) : undefined;
  const topRung = tenureItem
    ? Math.max(
        ...tenureItem.options
          .map((option) => option.value)
          .filter((value): value is number => typeof value === "number"),
      )
    : Number.NaN;
  const answers: AnswerMap =
    tenureItem && Number.isFinite(topRung)
      ? { [tenureItem.question_key]: settledNumber(tenureItem, topRung) }
      : {};
  return itemsForTier(items, tiers, tier).filter(
    (item) => item.question_key !== tenureKey && isFormQuestionVisible(item, answers),
  ).length;
}

/** Trade questions + shared page asks — the count the estimate is computed from. */
export function totalAsks(tradeQuestions: number, tier: ProfilingTier): number {
  return tradeQuestions + TIER_ESTIMATE_CONFIG.sharedPageAsks[tier];
}

/** Every tier's estimate for one role — override first, computed default otherwise. */
export function defaultEstimates(
  kind: TradeFormKindName,
  tradeQuestionsByTier: Readonly<Record<ProfilingTier, number>>,
): Record<ProfilingTier, MinutesRange & { question_count: number }> {
  const out = {} as Record<ProfilingTier, MinutesRange & { question_count: number }>;
  for (const tier of PROFILING_TIERS) {
    const questionCount = totalAsks(tradeQuestionsByTier[tier], tier);
    const range =
      TIER_ESTIMATE_CONFIG.overrides[kind]?.[tier] ?? estimateMinutes(questionCount, tier);
    out[tier] = { ...range, question_count: questionCount };
  }
  return out;
}

function settledNumber(item: QuestionPackItem, value: number): AnswerRecord {
  return {
    question_key: item.question_key,
    target_field: item.target_field,
    status: "answered",
    value_raw: null,
    value_normalized: value,
    evidence: null,
    turn: 0,
    history: [],
  };
}
