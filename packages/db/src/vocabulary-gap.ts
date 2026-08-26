/**
 * The match-vocabulary gap — and the constraint that sits UPSTREAM of it.
 *
 * ===========================================================================
 * THE QUESTION
 * ===========================================================================
 * Q1 left 91 of 96 promotable skills `INTENTIONALLY_UNMATCHED`, and 62 of them sit in the eight
 * trade families the triage recorded as unrepresented — battery manufacturing, masonry,
 * electrical installation, HVAC, warehouse, automotive service, assembly and sheet metal. The
 * obvious reading is that the match vocabulary is too small and needs eight more concepts.
 *
 * ===========================================================================
 * WHY THAT READING IS WRONG, AND IT IS CHECKABLE
 * ===========================================================================
 * A match skill only ever does anything when a JOB requires it. Jobs carry a `trade_key`, and
 * `TRADE_KEYS` is a **closed 15-value union** — the Phase-1 alpha trades — validated on the
 * posting path. `TRADE_TO_MATCH_SKILL` is exhaustive over it.
 *
 * So the reachable demand surface is not "whatever employers need". It is exactly the image of
 * 15 trade keys under one total function, and **every one of them already lands on an existing
 * `mskill_*`**. A new `mskill_battery_technician` could never be required by any job the
 * platform is able to accept, because no `trade_key` expresses a battery job.
 *
 * That inverts the finding. The vocabulary is not too small — it is **wider than the demand
 * surface**: 18 concepts against 15 trades that use 7 of them, leaving 11 `mskill_*` no job can
 * require. The unmatched skills describe supply the platform has no way to express demand for,
 * and the prior decision is the TRADE taxonomy — Phase-1 alpha scope, and a product question.
 *
 * Pure functions. This module decides nothing and invents no vocabulary.
 */
import { MATCH_SKILLS, TRADE_KEYS, TRADE_TO_MATCH_SKILL, type MatchSkillId } from "@badabhai/taxonomy";

/** What one trade family looks like once the bridge and the demand surface are both read. */
export interface FamilyGap {
  readonly family: string;
  readonly label: string;
  readonly promotableSkills: number;
  readonly matched: number;
  readonly intentionallyUnmatched: number;
  /**
   * `mskill_*` ids the family's PROMOTABLE SKILLS map to — the supply side of the bridge.
   *
   * Empty does NOT mean unserved. It means no attribute skill in this family carries a mapping,
   * which is a statement about `ATTRIBUTE_TO_MATCH_SKILLS` and not about whether a job in the
   * family reaches a match skill. Conflating the two produced a first draft that reported
   * `assembly` as needing new vocabulary while `assembly_technician` was already routed to
   * `mskill_fitter`.
   */
  readonly attributeSideMatchSkills: readonly string[];
  /** Trade keys that can express demand in this family. Empty = no job can be posted here. */
  readonly tradeKeys: readonly string[];
  /**
   * `mskill_*` ids the family's TRADE KEYS reach — the demand side.
   *
   * This is the one that decides whether new vocabulary is required, because a match skill only
   * ever does anything when a posting requires it.
   */
  readonly demandSideMatchSkills: readonly string[];
  /**
   * Would a NEW `mskill_*` for this family be reachable by any job?
   *
   * `false` is the interesting value: it means the concept would exist, satisfy the Q1 tripwire,
   * and never once be required — vocabulary that reads as progress and changes nothing.
   */
  readonly newVocabularyWouldBeReachable: boolean;
}

/**
 * The set of match skills any job can currently require.
 *
 * Derived from the closed trade union rather than from `MATCH_SKILLS`, because that is the
 * direction the constraint runs: demand is bounded by what a posting can SAY, not by what the
 * vocabulary can express.
 */
export function demandReachableMatchSkills(): ReadonlySet<MatchSkillId> {
  return new Set(TRADE_KEYS.map((t) => TRADE_TO_MATCH_SKILL[t]));
}

/** Match skills no job can require today. Not dead — unreachable, which is different. */
export function unreachableMatchSkills(): readonly string[] {
  const reachable = demandReachableMatchSkills();
  return MATCH_SKILLS.map((m) => m.skillId)
    .filter((id) => !reachable.has(id as MatchSkillId))
    .sort();
}

export interface FamilyInput {
  readonly family: string;
  readonly label: string;
  readonly skillIds: readonly string[];
}

/**
 * Build the gap matrix.
 *
 * `tradeKeysByFamily` is supplied by the caller rather than derived, because attributing a trade
 * key to a triage family is an ANALYTICAL judgement and belongs somewhere a reviewer can see it,
 * not buried in a helper.
 */
export function familyGaps(
  families: readonly FamilyInput[],
  bridge: Readonly<Record<string, readonly string[]>>,
  tradeKeysByFamily: Readonly<Record<string, readonly string[]>>,
): FamilyGap[] {
  return families
    .map((f) => {
      const targets = new Set<string>();
      let matched = 0;
      for (const id of f.skillIds) {
        const t = bridge[id] ?? [];
        if (t.length > 0) matched += 1;
        for (const x of t) targets.add(x);
      }
      const trades = tradeKeysByFamily[f.family] ?? [];
      const demandSide = [
        ...new Set(
          trades
            .map((t) => TRADE_TO_MATCH_SKILL[t as keyof typeof TRADE_TO_MATCH_SKILL])
            .filter((x): x is MatchSkillId => x !== undefined),
        ),
      ].sort();
      return {
        family: f.family,
        label: f.label,
        promotableSkills: f.skillIds.length,
        matched,
        intentionallyUnmatched: f.skillIds.length - matched,
        attributeSideMatchSkills: [...targets].sort(),
        tradeKeys: [...trades].sort(),
        demandSideMatchSkills: demandSide,
        // A new concept is reachable only if some trade key can require it. With no trade key,
        // adding vocabulary produces a mapping nothing can ever consult.
        newVocabularyWouldBeReachable: trades.length > 0,
      };
    })
    .sort((a, b) => b.promotableSkills - a.promotableSkills || a.family.localeCompare(b.family));
}

/**
 * Is new match vocabulary REQUIRED — as opposed to arguable?
 *
 * Required means: the family has promotable supply, has demand that can actually be POSTED, and
 * that demand reaches **no** `mskill_*`. Anything else is a proposal about a future trade
 * taxonomy rather than a gap in the present one.
 *
 * Judged on `demandSideMatchSkills`, never on the attribute side. An earlier version used the
 * bridge and reported `assembly` as requiring a new concept while `assembly_technician` was
 * already routed to `mskill_fitter` — the family's attribute skills carry no mapping and its
 * jobs are served perfectly well. Since `TRADE_TO_MATCH_SKILL` is TOTAL over `TRADE_KEYS`, the
 * honest expectation is that this returns empty, and the interesting day is the one it does not.
 */
export function newVocabularyRequired(gaps: readonly FamilyGap[]): readonly FamilyGap[] {
  return gaps.filter(
    (g) =>
      g.promotableSkills > 0 && g.tradeKeys.length > 0 && g.demandSideMatchSkills.length === 0,
  );
}
