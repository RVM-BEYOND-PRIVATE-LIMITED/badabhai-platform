/**
 * Matching V1 — the reach set and the match tier.
 *
 * A posting names up to three skills. Their curated RELATED skills arrive pre-ticked
 * (`relatedSkillsDefault: "on"`); the payer may untick any of them. The result is the
 * REACH SET — the exact set of match skills a candidate can qualify through.
 *
 * TWO RULES ARE ENFORCED HERE, not trusted from the caller:
 *  - an untick is only honoured if it names a SUGGESTED RELATED skill. A client that
 *    posts arbitrary ids gets them ignored, not applied.
 *  - a POSTED skill can NEVER be unticked. The payer said they need it; unticking it
 *    would be the payer excluding the very trade they advertised.
 */
import { relatedMatchSkills, isMatchSkillId, type MatchSkillId } from "@badabhai/taxonomy";
import type { WorkerSkillRow } from "./types";

function sortedUnique(ids: Iterable<MatchSkillId>): MatchSkillId[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export interface ResolveReachSetInput {
  /** The skills the payer posted. Non-closed-set ids are ignored. */
  postedSkillIds: readonly string[];
  /** `cfg.relatedSkillsDefault` — whether related skills come pre-ticked. */
  relatedDefault: "on" | "off";
  /** Client-supplied unticks. VALIDATED here; never trusted. */
  untickedIds?: readonly string[];
}

export interface ReachSet {
  /** Every match skill a candidate can qualify through. Sorted, deduped. */
  reachSkillIds: MatchSkillId[];
  /** The related skills OFFERED to the payer (the tickable set). Sorted, deduped. */
  suggestedRelatedIds: MatchSkillId[];
  /** The unticks that were actually honoured — the audit trail for the payer's edit. */
  appliedUntickedIds: MatchSkillId[];
  /** The posted skills, normalised. Tier-1 membership is decided against THIS. */
  postedSkillIds: MatchSkillId[];
}

/**
 * `reach = posted ∪ related(posted) ⊖ unticked`.
 *
 * With `relatedDefault: "off"` the reach set is the posted skills alone; the
 * suggestions are still returned so the UI can offer them. V1 ships with the default
 * "on", so the untick path is the live one.
 *
 * integration: apps/api must reject a posting whose TYPED skill list exceeds
 * `cfg.maxSkillsPerPosting`. This function deliberately does not truncate — silently
 * dropping a skill a payer paid to post is worse than a 400. The RELATED expansion is
 * deliberately uncapped (spec Part 5): breadth is bounded by the curated list and
 * controlled by the live reach counter on the form, not by that dial.
 */
export function resolveReachSet(input: ResolveReachSetInput): ReachSet {
  const posted = sortedUnique(input.postedSkillIds.filter(isMatchSkillId));

  const postedSet = new Set<MatchSkillId>(posted);
  const suggested = sortedUnique(
    posted.flatMap((p) => relatedMatchSkills(p).filter((r) => !postedSet.has(r))),
  );

  const suggestedSet = new Set<MatchSkillId>(suggested);
  // An untick counts ONLY if it names a suggested related skill. A posted skill can
  // never be unticked, and it cannot sneak in here because `suggested` excludes it.
  const applied = sortedUnique(
    (input.untickedIds ?? []).filter(isMatchSkillId).filter((id) => suggestedSet.has(id)),
  );

  const appliedSet = new Set<MatchSkillId>(applied);
  const related =
    input.relatedDefault === "on" ? suggested.filter((id) => !appliedSet.has(id)) : [];

  return {
    reachSkillIds: sortedUnique([...posted, ...related]),
    suggestedRelatedIds: suggested,
    appliedUntickedIds: applied,
    postedSkillIds: posted,
  };
}

/**
 * The skills a worker is actually SUPPLYING — rows they said they want (E12).
 *
 * History with `wants: false` still shows on the profile; it just does not put the
 * man in front of an employer for work he told us he does not want.
 */
export function wantedSkillIds(rows: readonly WorkerSkillRow[]): MatchSkillId[] {
  return sortedUnique(rows.filter((r) => r.wants).map((r) => r.skillId));
}

/**
 * BEST TIER WINS (E6). 1 = the worker holds a posted skill; 2 = a related one only;
 * `null` = no match at all, which means the worker is not a candidate.
 *
 * A worker holding BOTH an exact and a related skill is tier 1 — the exact match is
 * the truth about him, and the months that go with it are the exact skill's months
 * (see `skillMonthsFor` in rank.ts), even when the related skill is the longer one.
 */
export function matchTierFor(
  workerSkillIds: readonly string[],
  postedSkillIds: readonly string[],
): 1 | 2 | null {
  const posted = new Set<string>(postedSkillIds.filter(isMatchSkillId));
  if (posted.size === 0) return null;

  const worker = new Set<string>(workerSkillIds.filter(isMatchSkillId));
  for (const id of worker) if (posted.has(id)) return 1;

  for (const p of posted) {
    for (const r of relatedMatchSkills(p)) {
      if (worker.has(r)) return 2;
    }
  }
  return null;
}
