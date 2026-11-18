import { z } from "zod";

/**
 * #2750 item 1 — THE CREDIT RULES as settings (brief 4C.5 to 4C.12, section 7).
 *
 * Every number the brief's credit rules use lives here, never in code: what one contact costs, the
 * experience line for the higher cost, the welcome grant, the two opening limits, the couldn't-reach
 * windows, returned credits, the two refund rules and the goodwill cap. The values are stored as
 * one versioned row in `credit_rules_config` (migration `*_credit_rules_config`, owner ruling 2026-11-17: a sibling of
 * `match_config`, so money rules never share a row with the ranking knobs) and edited on
 * `PUT /admin/credit-rules`, which writes a new revision. Each key's default is the brief's value.
 *
 * WHY NOT `match_config`: `parseMatchConfig` falls back to its code defaults for the WHOLE object
 * when a stored row is invalid, and its `freeUnlockCredits` default is 50. A credit rule placed
 * there would tie a money change to the ranking row, and one bad edit of either would move both.
 *
 * TWO SCHEMAS, ONE SHAPE:
 *   - {@link CreditRulesSchema} reads a STORED row. Each key has its brief default, so a key added
 *     after a row was written takes its default rather than invalidating the row. Unknown keys are
 *     refused (`.strict()`), so a typo can never sit in the row looking like a rule.
 *   - {@link CreditRulesInputSchema} is the EDIT body: every key required. An admin who sends a
 *     partial object is refused rather than having the missing keys silently reset to defaults.
 *
 * FAIL CLOSED, WHOLE OBJECT: {@link parseCreditRules} never throws and never takes the good half of a
 * bad row: an invalid row yields {@link DEFAULT_CREDIT_RULES} whole (the `parseMatchConfig` rule).
 *
 * Pure, PII-free, no LLM: integers only (CLAUDE.md invariant 4).
 */

/** A bounded whole number. The bounds stop a typo (an extra zero) from reaching a wallet. */
const int = (min: number, max: number) => z.number().int().min(min).max(max);

/** The keys, their bounds and the brief's values. Shared by both schemas below. */
const RULE_FIELDS = {
  /** Credits to open one contact at the standard cost (brief 4C.5: 1). */
  standardCost: int(1, 10).default(1),
  /** Credits to open one contact at the higher cost (brief 4C.5: 2; B4C-10 makes it a setting). */
  higherCost: int(1, 20).default(2),
  /**
   * Months of experience in the higher-priced trade at which the higher cost starts (brief 4C.5:
   * 3 years). NOT `match_config.tierFloorMonths`: that is a ranking setting and must not move the
   * price (#2750 private notes).
   */
  higherCostMinMonths: int(1, 600).default(36),
  /** Welcome credits, once per verified company, after its first approved post (B2-20, B4C-11). */
  welcomeCredits: int(0, 100).default(5),
  /** Days the welcome credits stay valid (B2-21). */
  welcomeValidityDays: int(1, 365).default(30),
  /** First-time opens of one worker, all companies, in a rolling 7 days (B4C-17, B7-12). */
  workerWeeklyOpenLimit: int(1, 100).default(5),
  /** Opens per IST calendar day for an agency or contractor account (B4C-18). */
  agencyDailyOpenLimit: int(1, 1000).default(40),
  /** Days after an open in which a couldn't-reach report is accepted (B7-13). */
  couldntReachWindowDays: int(1, 60).default(7),
  /** Hours the worker desk has to reach the worker before the credits return (brief 4C.9). */
  deskWindowHours: int(1, 720).default(48),
  /** Most credits returned with a new pack (B4C-24). */
  returnedCreditsMax: int(0, 1000).default(20),
  /** Months after the old pack's expiry date in which a new pack still brings them back (B7-10). */
  returnedCreditsWindowMonths: int(0, 36).default(6),
  /** Days a credit returned after its lot expired stays valid in its new lot (#2750 defaults). */
  returnedLotValidityDays: int(1, 365).default(30),
  /** Refund rule 1: an unused pack, within this many days of purchase (B4C-26). */
  refundUnusedWithinDays: int(0, 90).default(7),
  /** Refund rule 2: an unused pack, within this many days ... (B4C-27) */
  refundLowMatchWithinDays: int(0, 90).default(30),
  /** ... if the job drew FEWER than this many matching workers (B7-14). */
  refundLowMatchMinWorkers: int(1, 100).default(3),
  /** Most goodwill credits per company per IST calendar quarter (B4C-28). */
  goodwillMaxPerQuarter: int(0, 1000).default(5),
  /** Days goodwill credits stay valid (#2750 defaults). */
  goodwillValidityDays: int(1, 365).default(30),
} as const;

/** The setting names, in the order above. The edit route's event names the keys that changed. */
export const CREDIT_RULE_KEYS = Object.freeze(
  Object.keys(RULE_FIELDS) as (keyof typeof RULE_FIELDS)[],
);
export type CreditRuleKey = (typeof CREDIT_RULE_KEYS)[number];

/** The higher cost may never be below the standard one: "higher" would then be a discount. */
const higherNotBelowStandard = (r: { standardCost: number; higherCost: number }) =>
  r.higherCost >= r.standardCost;
const HIGHER_BELOW_STANDARD = {
  message: "higherCost must be at least standardCost",
  path: ["higherCost"],
};

/** A STORED row: brief defaults per key, unknown keys refused. */
export const CreditRulesSchema = z
  .object(RULE_FIELDS)
  .strict()
  .refine(higherNotBelowStandard, HIGHER_BELOW_STANDARD);
export type CreditRules = z.infer<typeof CreditRulesSchema>;

/** The EDIT body: the same keys and bounds, every key required, unknown keys refused. */
export const CreditRulesInputSchema = z
  .object(
    Object.fromEntries(
      Object.entries(RULE_FIELDS).map(([key, field]) => [key, field.removeDefault()]),
    ) as { [K in CreditRuleKey]: ReturnType<(typeof RULE_FIELDS)[K]["removeDefault"]> },
  )
  .strict()
  .refine(higherNotBelowStandard, HIGHER_BELOW_STANDARD);

/** The brief's values, frozen. What an absent or invalid row serves. */
export const DEFAULT_CREDIT_RULES: CreditRules = Object.freeze(CreditRulesSchema.parse({}));

/**
 * Parse a stored row. FAILS CLOSED to {@link DEFAULT_CREDIT_RULES}, whole: never throws, never logs,
 * never keeps the valid half of an invalid row.
 */
export function parseCreditRules(raw: unknown): CreditRules {
  const parsed = CreditRulesSchema.safeParse(raw);
  return parsed.success ? Object.freeze(parsed.data) : DEFAULT_CREDIT_RULES;
}

/** The keys whose value differs between two rule sets, in {@link CREDIT_RULE_KEYS} order. */
export function changedCreditRuleKeys(before: CreditRules, after: CreditRules): CreditRuleKey[] {
  return CREDIT_RULE_KEYS.filter((key) => before[key] !== after[key]);
}
