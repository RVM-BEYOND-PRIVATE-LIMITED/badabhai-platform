import { isMatchSkillId, type MatchSkillId } from "./match-skills";
import { packReachableMatchSkills } from "./pack-answer-skills";
import {
  POSTING_TRADES,
  isLivePostingTradeKind,
  postingTradeFor,
  type PostingTradeKind,
} from "./posting-trades";

/**
 * MATCHING RUNS ONLY FOR THE 16 POSTABLE TRADES (owner ruling 2026-11-04, #2635).
 *
 * The app profiles workers in more trades than the 16 a company can post, and it keeps every
 * one of those profiles and their `worker_skill` rows. What this file bounds is MATCHING: which
 * `mskill_*` ids a 16-trade job may name and reach.
 *
 *   - A trade's OWN skill set is its base skill plus every skill its own question pack's chips
 *     can name (`packReachableMatchSkills`) — the same closed bridge the worker derive path
 *     reads, so a job can ask for exactly what that trade's workers can hold.
 *   - THE SCOPE is the union of the 16 LIVE trades' own sets. Related expansion of a posting-
 *     trade job never leaves it, so a Fitter job reaches Maintenance and QC workers but never a
 *     plumber.
 *
 * #3005 — THE SCOPE STAYS ON THE 16. The 44 trades of CEO pack v2 are postable trades (each has
 * its own set below, so a job for one scopes to it), but their skills are not in the scope yet:
 * section-5 pairs (#3001) relate live skills to new ones, and a scope holding the new skills
 * would widen the reach of LIVE jobs on their next rebuild before any owner switched a wave on.
 * Widening the scope to a wave is part of switching that wave on (#3013, checked by #3051).
 *
 * WHY HERE. Both writers of a job's match set (`MatchSkillsService.resolveForPublish` at create,
 * publish, edit and unpause) and the reach preview must agree on one table. It is a pure
 * function of the checked-in catalogue: no I/O, no model, no tunable.
 *
 * WHAT THIS IS NOT. It never removes a worker's skill and never decides who a non-16 posting
 * (ops, agency) reaches — those keep their pre-#2635 behaviour.
 */

function ownSkillsOf(packId: string, baseSkillId: string): readonly MatchSkillId[] {
  const own = new Set<MatchSkillId>();
  if (isMatchSkillId(baseSkillId)) own.add(baseSkillId);
  for (const id of packReachableMatchSkills(packId)) own.add(id);
  return [...own].sort();
}

const OWN_SKILLS_BY_TRADE: ReadonlyMap<PostingTradeKind, readonly MatchSkillId[]> = new Map(
  POSTING_TRADES.map((trade) => [trade.roleKind, ownSkillsOf(trade.packId, trade.matchSkillId)]),
);

/** Every `mskill_*` a related expansion may reach: the 16 live trades' own sets. Sorted, deduped. */
export const POSTING_SCOPE_SKILL_IDS: readonly MatchSkillId[] = [
  ...new Set(
    [...OWN_SKILLS_BY_TRADE.entries()]
      .filter(([kind]) => isLivePostingTradeKind(kind))
      .flatMap(([, skills]) => skills),
  ),
].sort();

const POSTING_SCOPE_SET: ReadonlySet<string> = new Set(POSTING_SCOPE_SKILL_IDS);

/** Whether a match skill is inside the 16-trade matching scope. */
export function isInPostingScope(skillId: string): boolean {
  return POSTING_SCOPE_SET.has(skillId);
}

/**
 * The skills a job for this trade may name: its base skill plus its own pack's chip skills.
 * `undefined` when the role is not a postable trade (or is null).
 */
export function postingTradeSkillIds(
  roleKind: string | null | undefined,
): readonly MatchSkillId[] | undefined {
  const trade = postingTradeFor(roleKind);
  return trade ? OWN_SKILLS_BY_TRADE.get(trade.roleKind) : undefined;
}

/** A job's requested match skills after scoping them to its trade. */
export interface ScopedPostingSkills {
  /** The trade's base skill first, then every requested id the trade owns, first-seen order. */
  readonly kept: MatchSkillId[];
  /** Requested ids the trade does not own, first-seen order, deduped. Never the base skill. */
  readonly dropped: string[];
}

/**
 * Scope a 16-trade job's requested skills to its trade.
 *
 * The base skill is ALWAYS kept (a job that names a trade can never reach nobody), every
 * requested id the trade owns is kept, and everything else is dropped — never rejected: the
 * caller records the drop on an event. `undefined` when the role is not a postable trade, so the
 * caller keeps the pre-#2635 behaviour for it.
 *
 * Deterministic and order-preserving: the same request always yields the same lists.
 */
export function scopePostingSkills(
  roleKind: string | null | undefined,
  requested: readonly string[],
): ScopedPostingSkills | undefined {
  const trade = postingTradeFor(roleKind);
  if (!trade || !isMatchSkillId(trade.matchSkillId)) return undefined;
  const own = new Set<string>(OWN_SKILLS_BY_TRADE.get(trade.roleKind) ?? []);
  const kept: MatchSkillId[] = [trade.matchSkillId];
  const dropped: string[] = [];
  for (const id of requested) {
    if (kept.includes(id as MatchSkillId) || dropped.includes(id)) continue;
    if (isMatchSkillId(id) && own.has(id)) kept.push(id);
    else dropped.push(id);
  }
  return { kept, dropped };
}
