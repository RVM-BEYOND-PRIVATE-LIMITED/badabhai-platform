/**
 * Matching V1 — the whole config surface.
 *
 * "Six lines. Ships as Remote Config. Never hard-coded." Nine values in practice,
 * because the money dials (free unlock credits, the boost supply floor) ride the same
 * surface. Everything an operator can turn is HERE; nothing else in this package
 * reads a tunable.
 *
 * There are NO SCORING DIALS in this object — no factor multipliers, no ledger, no
 * knobs that change the ORDER of the comparator. V1 ranks by a fixed lexicographic
 * key (`rank.ts`), and the only value that touches ordering is `tierFloorMonths`,
 * which is a THRESHOLD (owner ruling 2026-07-31: tier-with-floor at 36 months), not a
 * multiplier. That is deliberate: a config change can never silently re-weight the
 * feed, because there is nothing to re-weight.
 */
import { z } from "zod";

/**
 * The config schema.
 *
 * Every field has a typed default, so a partial remote config is legal and any
 * absent field falls back. Unknown keys are STRIPPED rather than rejected: a remote
 * config that grows a key ahead of a deploy must not knock the whole object back to
 * defaults.
 */
export const MatchConfigSchema = z.object({
  /** Stamped on every explanation/audit trail so a rank is reproducible. */
  engineVersion: z.string().min(1).default("v1.0"),
  /** Months bucket to 6. No false precision on a number a man estimated. */
  monthBucket: z.number().int().positive().default(6),
  /** A posting names at most this many skills. */
  maxSkillsPerPosting: z.number().int().positive().default(3),
  /** Related skills arrive pre-ticked; the payer may untick them. */
  relatedSkillsDefault: z.enum(["on", "off"]).default("on"),
  /** Feed rule: at most this many consecutive cards from the same company. */
  maxConsecutiveSameCompany: z.number().int().positive().default(2),
  /** Per-job applicant quota — OFF at launch. */
  applicantQuota: z.enum(["on", "off"]).default("off"),
  /**
   * TIER FLOOR (owner ruling, 2026-07-31). A tier-2 (related-skill) worker with at
   * least this many months on that skill is promoted to tier 1 for ordering. 36
   * months = three years: long enough that "he does the adjacent trade" stops being
   * a guess.
   */
  tierFloorMonths: z.number().int().nonnegative().default(36),
  /** Credits a new payer starts with. */
  freeUnlockCredits: z.number().int().nonnegative().default(50),
  /** A boost is refused below this much matched supply — boosting nothing is a lie. */
  boostSupplyFloor: z.number().int().nonnegative().default(25),
});

export type MatchConfig = z.infer<typeof MatchConfigSchema>;

/**
 * The typed defaults — the shipped V1 values. Frozen: a caller that mutates the
 * default config would silently re-rank every feed in the process.
 */
export const DEFAULT_MATCH_CONFIG: MatchConfig = Object.freeze(MatchConfigSchema.parse({}));

/**
 * Parse a raw remote-config blob. FAILS CLOSED: any invalid input — wrong type,
 * negative bucket, garbage enum, `null`, a string, anything — yields the shipped
 * defaults. Never throws, never logs, never partially applies a broken config.
 *
 * Fail-closed is at the WHOLE-OBJECT level on purpose. A config where one field is
 * garbage is a config we do not understand; taking the good half of it would ship an
 * ordering nobody reviewed.
 */
export function parseMatchConfig(raw: unknown): MatchConfig {
  const parsed = MatchConfigSchema.safeParse(raw);
  return parsed.success ? Object.freeze(parsed.data) : DEFAULT_MATCH_CONFIG;
}
