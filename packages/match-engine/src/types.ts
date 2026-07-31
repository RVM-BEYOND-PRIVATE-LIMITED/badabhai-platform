/**
 * Matching V1 — the shapes the engine consumes.
 *
 * Plain data, no persistence coupling: the API maps DB rows onto these at the
 * boundary. Nothing here carries PII — a worker is an opaque id, a company is an
 * opaque key (CLAUDE.md §2 #2).
 *
 * TIME ENTERS AS DATA. Dates are ISO-8601 strings supplied by the caller and are
 * never resolved against a clock inside this package. `lastWorkedAt` and `createdAt`
 * are SNAPSHOT values, frozen when the row was written (E16).
 */
import type { IndustryId, MatchSkillId } from "@badabhai/taxonomy";

/** A match skill in its industry — the unit both a posting and a worker are stated in. */
export interface MatchSkillRef {
  skillId: MatchSkillId;
  industryId: IndustryId;
}

/**
 * One row of a worker's skill history.
 *
 * `monthsBucketed` is already bucketed (see `months.ts`) — the engine never re-buckets
 * and never invents precision.
 *
 * `wants` is the worker's own answer to "do you want this kind of work?". A row with
 * `wants: false` is history, not supply: it shows on the profile and is EXCLUDED from
 * reach (E12).
 *
 * `startedAt`/`endedAt` are `null` at launch (worker history is COARSE — one bucketed
 * total, not per-job stints). They exist so that per-job history is later a DATA
 * change, not a rewrite: `tenure.ts` already merges intervals correctly.
 */
export interface WorkerSkillRow {
  skillId: MatchSkillId;
  industryId: IndustryId;
  monthsBucketed: number;
  wants: boolean;
  /** ISO-8601 date, or `null` when the stint dates are unknown (the launch case). */
  startedAt: string | null;
  /** ISO-8601 date, `null` for ongoing OR unknown. */
  endedAt: string | null;
}

/**
 * Everything the comparator is allowed to see about one candidate for one job.
 *
 * This is a SNAPSHOT, deliberately narrow: if a value is not on this object the
 * ordering cannot depend on it. There is no worker profile here, no employer name, no
 * pay, no distance, no activity — and no place to smuggle one in.
 */
export interface RankInputs {
  /**
   * 1 = the worker holds the EXACT posted skill; 2 = a related skill only.
   *
   * Preserved as-is through ranking. `effectiveTier` (rank.ts) may promote a tier-2
   * worker past the floor, but `matchTier` keeps the truth so the UI can still show
   * the "related skill" badge (E18).
   */
  matchTier: 1 | 2;
  /** Bucketed months on the matched skill (E5/E6/E7 decide WHICH skill that is). */
  skillMonths: number;
  /** Bucketed calendar months in the JOB'S industry (E7/E8). */
  industryMonths: number;
  /** ISO-8601 date of the worker's last known work, or `null` if never/unknown. */
  lastWorkedAt: string | null;
  /** ISO-8601 timestamp the candidate row was created — the recency tiebreak. */
  createdAt: string;
  /** Opaque, stable id (application id / worker id). The final total-order tiebreak. */
  id: string;
}

/** One card in a worker's job feed. `payerKey` is an opaque company key, never a name. */
export interface FeedRow {
  jobId: string;
  payerKey: string;
  boosted: boolean;
  /** ISO-8601 timestamp. */
  publishedAt: string;
}
