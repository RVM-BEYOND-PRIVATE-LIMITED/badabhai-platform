import { z } from "zod";

/**
 * #2890 — THE DAILY FLOW CHECK'S THRESHOLDS, held as ONE setting (`FLOW_CHECK_THRESHOLDS`).
 *
 * The value is a comma-separated list of `key=value` pairs, for example
 * `review_wait_hours=72,zero_reach_max=5`. A key left out keeps its default below; empty or unset
 * means every default. Two kinds of key:
 *
 *   - `*_hours`: how long something may wait before it counts, whole hours, 1 to 720.
 *   - `*_max`: the largest count that is NOT a breach, a whole number 0 to 100000, or `off` (the
 *     count is still recorded every day, it just never alerts). `0` means "any one is a breach".
 *
 * A malformed value, an unknown key or a key given twice FAILS BOOT, so a typo is never silently
 * ignored. The deploy preflight (`scripts/deploy/staging-deploy.sh`) checks the same grammar and key
 * list before a container moves, so a bad production secret stops the deploy instead of
 * crash-looping the api.
 */
export const FLOW_CHECK_THRESHOLD_DEFAULTS = {
  /** An RVM-audience job's placement-team review counts as overdue after this many hours (#2769). */
  review_wait_hours: 48,
  /** Overdue reviews tolerated before a breach. */
  review_overdue_max: 0,
  /** A live job counts as zero-reach once it has been published this many hours with no reach row. */
  zero_reach_grace_hours: 24,
  /** Live zero-reach jobs tolerated before a breach. */
  zero_reach_max: 0,
  /** An application counts as untouched when no company acted on it within this many hours. */
  untouched_hours: 72,
  /** Untouched applications tolerated before a breach. Off by default: it is a company's pace. */
  untouched_max: null,
  /** Campus applications whose BadaBhai row is gone (not withdrawn) tolerated before a breach (#2782). */
  campus_unlinked_max: 0,
  /** Campus outbox rows not delivered, as Campus last reported, tolerated before a breach. */
  outbox_undelivered_max: 0,
  /** Campus application ids that never reached BadaBhai, as Campus last reported (#2782). */
  campus_missing_max: 0,
  /**
   * How old Campus's latest report may be, in hours, before its absence is itself a breach (while
   * the Campus link is on, and unless both Campus maxima above are `off`).
   */
  campus_report_max_age_hours: 26,
} as const satisfies Record<string, number | null>;

export type FlowCheckThresholdKey = keyof typeof FLOW_CHECK_THRESHOLD_DEFAULTS;

/** Every key, in the order above. The deploy preflight's list is checked against this one. */
export const FLOW_CHECK_THRESHOLD_KEYS = Object.keys(
  FLOW_CHECK_THRESHOLD_DEFAULTS,
) as FlowCheckThresholdKey[];

/** The parsed thresholds: hours are numbers, a `*_max` is a number or null (`off`). */
export type FlowCheckThresholds = { [K in FlowCheckThresholdKey]: number | null } & {
  review_wait_hours: number;
  zero_reach_grace_hours: number;
  untouched_hours: number;
  campus_report_max_age_hours: number;
};

export const FLOW_CHECK_MAX_HOURS = 720;
export const FLOW_CHECK_MAX_COUNT = 100_000;

const isHoursKey = (key: string): boolean => key.endsWith("_hours");

/**
 * Parse a `FLOW_CHECK_THRESHOLDS` value. Throws with a message naming the bad pair; never returns a
 * partial result.
 */
export function parseFlowCheckThresholds(raw: string | undefined): FlowCheckThresholds {
  const out: Record<string, number | null> = { ...FLOW_CHECK_THRESHOLD_DEFAULTS };
  const text = (raw ?? "").trim();
  if (text === "") return out as FlowCheckThresholds;
  const seen = new Set<string>();
  for (const pair of text.split(",")) {
    const match = /^\s*([a-z_]+)\s*=\s*([0-9]{1,6}|off)\s*$/.exec(pair);
    if (!match) throw new Error(`"${pair.trim()}" is not key=value`);
    const [, key, value] = match as unknown as [string, string, string];
    if (!(key in FLOW_CHECK_THRESHOLD_DEFAULTS)) throw new Error(`unknown key "${key}"`);
    if (seen.has(key)) throw new Error(`"${key}" is given twice`);
    seen.add(key);
    if (isHoursKey(key)) {
      const hours = Number(value);
      if (value === "off" || hours < 1 || hours > FLOW_CHECK_MAX_HOURS) {
        throw new Error(`"${key}" must be whole hours from 1 to ${FLOW_CHECK_MAX_HOURS}`);
      }
      out[key] = hours;
    } else if (value === "off") {
      out[key] = null;
    } else {
      const max = Number(value);
      if (max > FLOW_CHECK_MAX_COUNT) {
        throw new Error(`"${key}" must be 0 to ${FLOW_CHECK_MAX_COUNT}, or off`);
      }
      out[key] = max;
    }
  }
  return out as FlowCheckThresholds;
}

/** The zod field: a string (or unset) parsed into the thresholds; a bad value fails boot. */
export const flowCheckThresholdsFromString = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    try {
      return parseFlowCheckThresholds(raw);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `FLOW_CHECK_THRESHOLDS: ${err instanceof Error ? err.message : "invalid"}`,
      });
      return z.NEVER;
    }
  });
