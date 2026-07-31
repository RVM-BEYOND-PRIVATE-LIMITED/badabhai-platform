/**
 * Matching V1 — the rank key. This is the heart of the algorithm.
 *
 * THERE IS NO SCORE. No factor multipliers, no ledger, no tunable that reshuffles the
 * feed. Ordering is a single LEXICOGRAPHIC comparison over five facts and one
 * tiebreak, in this fixed order:
 *
 *   1. effectiveTier      ASC   exact-skill (or a floor-promoted related) first
 *   2. skillMonths        DESC  time on the matched skill
 *   3. industryMonths     DESC  time in the job's industry
 *   4. lastWorkedAt       DESC  recency, NULLS LAST
 *   5. lastActiveAt       DESC  the spec's `last_active_at`
 *   6. id                 ASC   the spec's `stable_hash` — a total order, always
 *
 * Field for field the spec's tuple (Part 4 / moment ⑥):
 *   ( match_tier ASC, skill_months DESC, industry_months DESC,
 *     last_worked_at DESC, last_active_at DESC, stable_hash ASC )
 *
 * A lexicographic key is the point, not a simplification. It is explainable to a
 * payer in one sentence ("he has the skill and more months on it"), it cannot be
 * gamed by inflating one dimension, and it can be reproduced by hand from the row.
 *
 * OWNER RULING 2026-07-31 — TIER WITH FLOOR. Strict tier ordering would have put a
 * six-month exact match above a ten-year related one, which no shop supervisor would
 * accept. A related-skill worker with `tierFloorMonths` (36) or more months on that
 * skill is promoted to tier 1 for ORDERING. `matchTier` itself is never overwritten,
 * so the UI still badges him as a related match (E18).
 */
import { relatedMatchSkills, isMatchSkillId, type MatchSkillId } from "@badabhai/taxonomy";
import type { MatchConfig } from "./config";
import type { RankInputs, WorkerSkillRow } from "./types";

/**
 * The tier ORDERING uses. Tier 2 with enough months on the related skill ranks as
 * tier 1; everything else is its own tier. Never mutates `matchTier`.
 */
export function effectiveTier(
  matchTier: 1 | 2,
  skillMonths: number,
  tierFloorMonths: number,
): 1 | 2 {
  if (matchTier <= 1) return 1;
  const months = Number.isFinite(skillMonths) ? skillMonths : 0;
  const floorMonths = Number.isFinite(tierFloorMonths) ? tierFloorMonths : 0;
  return months >= floorMonths ? 1 : 2;
}

/** Non-finite months sort as 0 — a corrupt row must not out-rank a real one. */
function finiteMonths(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Lexicographic string comparison — ISO-8601 sorts chronologically as text. */
function textAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * THE reference comparator. Total, stable, deterministic: no clock, no randomness, no
 * lookup outside the two snapshots it is handed.
 *
 * Two rows with the same `id` compare equal — by construction, because `id` is the
 * last key. That is the engine-level statement of E15: uniqueness of (worker, job)
 * cannot be established here and MUST be enforced by the caller.
 */
export function rankKeyCompare(a: RankInputs, b: RankInputs, cfg: MatchConfig): number {
  const tierA = effectiveTier(a.matchTier, a.skillMonths, cfg.tierFloorMonths);
  const tierB = effectiveTier(b.matchTier, b.skillMonths, cfg.tierFloorMonths);
  if (tierA !== tierB) return tierA - tierB;

  const skillDelta = finiteMonths(b.skillMonths) - finiteMonths(a.skillMonths);
  if (skillDelta !== 0) return skillDelta;

  const industryDelta = finiteMonths(b.industryMonths) - finiteMonths(a.industryMonths);
  if (industryDelta !== 0) return industryDelta;

  // Recency, NULLS LAST: "we do not know when he last worked" never beats a date.
  if (a.lastWorkedAt !== b.lastWorkedAt) {
    if (a.lastWorkedAt === null) return 1;
    if (b.lastWorkedAt === null) return -1;
    const recency = textAsc(b.lastWorkedAt, a.lastWorkedAt);
    if (recency !== 0) return recency;
  }

  const active = textAsc(b.lastActiveAt, a.lastActiveAt);
  if (active !== 0) return active;

  return textAsc(a.id, b.id);
}

export interface SkillMonthsInput {
  /** The worker's full skill rows (all industries). */
  workerRows: readonly WorkerSkillRow[];
  /** The skills the JOB posted (not the reach set — tier 1 is exact-posted only). */
  postedSkillIds: readonly string[];
  /** The tier already decided by `matchTierFor`. */
  matchedTier: 1 | 2;
}

/**
 * Months on the MATCHED skill.
 *
 * E5 — a posting may name several skills. The worker's number is the MAX across the
 *      posted skills he actually holds, not a sum: he is being hired for one of them.
 * E6 — a worker holding an exact AND a related skill is tier 1, and his months are
 *      the EXACT skill's months even when the related skill is the longer one.
 *      Counting the related months there would sell the payer time on another machine.
 * E7 — the same skill in two industries SUMS: eighteen months turning at a pump shop
 *      and twenty-four at an auto shop is forty-two months of turning. The industry
 *      number stays per-industry (see `tenure.ts`); only the skill total crosses.
 *
 * Rows are taken as given. Reach has already excluded work the man does not want, so
 * filtering `wants` again here would double-apply a rule that belongs upstream.
 */
export function skillMonthsFor(input: SkillMonthsInput): number {
  const posted = new Set<string>(input.postedSkillIds.filter(isMatchSkillId));
  if (posted.size === 0) return 0;

  let eligible: Set<string>;
  if (input.matchedTier === 1) {
    eligible = posted;
  } else {
    eligible = new Set<string>();
    for (const p of posted) {
      for (const r of relatedMatchSkills(p)) {
        if (!posted.has(r)) eligible.add(r);
      }
    }
  }

  // Sum per skill across industries (E7), then take the max across skills (E5).
  const perSkill = new Map<MatchSkillId, number>();
  for (const row of input.workerRows) {
    if (!eligible.has(row.skillId)) continue;
    perSkill.set(row.skillId, (perSkill.get(row.skillId) ?? 0) + finiteMonths(row.monthsBucketed));
  }

  let best = 0;
  for (const months of perSkill.values()) if (months > best) best = months;
  return best;
}

/**
 * FEED RULE — at most `max` consecutive cards from the same company.
 *
 * A worker opening the app should not see one factory eight times. This is a
 * presentation rule, not a filter: it NEVER drops a row. The output is a permutation
 * of the input, same length, same multiset.
 *
 * It preserves relative order otherwise: at every step it takes the EARLIEST row that
 * does not break the run limit, so within a company the original order is intact and
 * across companies nothing jumps further than the rule requires.
 *
 * DEGRADES HONESTLY. When only one company remains, a longer run is unavoidable — the
 * rule cannot conjure a second employer. In that case the remaining rows are emitted
 * in their original order rather than dropped or padded.
 */
export function interleaveMaxPerCompany<T extends { payerKey: string }>(
  rows: readonly T[],
  max: number,
): T[] {
  const limit = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 1;
  const remaining = [...rows];
  const out: T[] = [];
  let runKey: string | null = null;
  let runLength = 0;

  while (remaining.length > 0) {
    let index = remaining.findIndex(
      (row) => !(row.payerKey === runKey && runLength >= limit),
    );
    // Everything left belongs to the company already at its limit: unavoidable run.
    if (index === -1) index = 0;

    const [row] = remaining.splice(index, 1);
    if (row === undefined) break;
    if (row.payerKey === runKey) {
      runLength += 1;
    } else {
      runKey = row.payerKey;
      runLength = 1;
    }
    out.push(row);
  }

  return out;
}
