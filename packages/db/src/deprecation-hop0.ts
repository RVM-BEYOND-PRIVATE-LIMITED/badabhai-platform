/**
 * HOP 0 — what a deprecation does to RETRIEVAL, as distinct from what it does to the crosswalk.
 *
 * ===========================================================================
 * THE MISTAKE THIS MODULE EXISTS TO PREVENT
 * ===========================================================================
 * "Is this deprecation safe?" is routinely answered by subtracting two rows of
 * `ATTRIBUTE_TO_MATCH_SKILLS`:
 *
 *     subject.bridge === successor.bridge   →   "match-set neutral, ship it"
 *
 * That subtraction assumes the phrase LANDS ON THE SUCCESSOR. Retrieval never reads
 * `replaced_by`. It filters `s.status = 'active'`, which removes the deprecated skill's own
 * aliases from the candidate pool and promotes **the nearest active neighbour** — which is
 * whatever else happens to sit in that scope, successor or not.
 *
 * So the bridge delta answers a question nobody asked. Three measured consequences, all from
 * this programme, none visible to a bridge subtraction:
 *
 *   D-7B  `chassis assembly` → `skill_mechanical_assembly` (a BRIDGED non-successor) above the
 *         floor. The deprecation alone conferred `mskill_fitter`. Bridge delta: zero.
 *   D-7A  `boring` → `skill_drilling`, an UNMAPPED non-successor, above the floor. No claim,
 *         but a wrong skill written to a worker's profile. Bridge delta: zero.
 *   D-7C  `dimensional inspection` → `skill_drawing_reading` at 0.7570, above the floor, in
 *         both canonical domains. Reading a drawing is not inspecting a part. Bridge delta:
 *         zero.
 *
 * Hence: **a landing is only neutral if the thing it lands on is neutral.** Two skills, both
 * with `[]`, are not interchangeable — one of them may be the wrong concept.
 *
 * A second rule the floor makes easy to miss: a landing BELOW the floor confers nothing at all,
 * because the assignment never happens. That makes some deprecations neutral *by accident* —
 * neutral only for as long as the floor stays where it is. `matchSetDelta` records that as
 * `neutralOnlyViaFloor` rather than folding it into a clean pass, because the two are different
 * risks and only one of them survives a floor change.
 *
 * NO IO. The database work lives in `audit-deprecation-hop0.ts`; this file is the rule, so the
 * rule can be tested without a production connection.
 */

/** Where a phrase resolved, and how strongly. */
export interface Landing {
  /** The skill whose alias won the nearest-neighbour search. */
  readonly skillId: string;
  /** Cosine similarity, 0..1. */
  readonly score: number;
}

/**
 * One phrase, in one scope, measured on both sides of a hypothetical deprecation.
 *
 * `ifSeeded` is `null` when the scope contains no other active alias at all — the phrase
 * becomes unresolvable rather than landing somewhere new.
 */
export interface Hop0Observation {
  readonly subject: string;
  readonly phrase: string;
  /** The retrieval scope: a legacy `domain_id` slug or a canonical `job_domain_id`. */
  readonly scope: string;
  readonly scopeKind: "legacy" | "canonical";
  readonly today: Landing;
  readonly ifSeeded: Landing | null;
}

export type Hop0Verdict =
  /** Above the floor, and on the successor the crosswalk actually names. The intended outcome. */
  | "LANDS_ON_SUCCESSOR"
  /** Above the floor, on something the crosswalk never named. The D-7A/D-7B/D-7C defect class. */
  | "LANDS_ELSEWHERE_ABOVE_FLOOR"
  /** Below the floor: the phrase stops resolving. No claim, but a coverage loss. */
  | "FALLS_BELOW_FLOOR"
  /** The phrase already resolved here while the subject was active. The deprecation moves nothing. */
  | "UNCHANGED";

/**
 * Classify one observation.
 *
 * `UNCHANGED` is tested FIRST and deliberately outranks the others: if the phrase already
 * lands on this skill today, the deprecation is not what put it there, and attributing the
 * landing to the deprecation would manufacture a finding. This happens whenever the successor
 * already carries a duplicate of the alias — which is exactly the state a completed merge
 * leaves behind, so it is the common case rather than the odd one.
 */
export function classifyLanding(
  o: Hop0Observation,
  successorId: string | null,
  floor: number,
): Hop0Verdict {
  if (o.ifSeeded === null) return "FALLS_BELOW_FLOOR";
  if (o.today.skillId === o.ifSeeded.skillId) return "UNCHANGED";
  if (o.ifSeeded.score < floor) return "FALLS_BELOW_FLOOR";
  return o.ifSeeded.skillId === successorId ? "LANDS_ON_SUCCESSOR" : "LANDS_ELSEWHERE_ABOVE_FLOOR";
}

export interface MatchSetDelta {
  /** Match skills the phrase would newly confer. **Non-empty means widening.** */
  readonly gained: readonly string[];
  /** Match skills the phrase would stop conferring. */
  readonly lost: readonly string[];
  /**
   * True when the landing is bridged but scores below the floor, so the claim does not fire.
   * Neutral today; neutral only because of where the floor sits.
   */
  readonly neutralOnlyViaFloor: boolean;
}

/**
 * What a single landing does to the match claims a phrase can produce.
 *
 * `landingBridge` is the bridge row of the skill actually landed on — NOT the successor's.
 * Passing the successor's row here reintroduces the very assumption this module exists to
 * remove.
 */
export function matchSetDelta(
  subjectBridge: readonly string[],
  landing: Landing | null,
  landingBridge: readonly string[],
  floor: number,
): MatchSetDelta {
  const fires = landing !== null && landing.score >= floor;
  const conferred = fires ? landingBridge : [];
  const gained = conferred.filter((m) => !subjectBridge.includes(m));
  const lost = subjectBridge.filter((m) => !conferred.includes(m));
  return {
    gained,
    lost,
    neutralOnlyViaFloor: !fires && landingBridge.length > 0,
  };
}

export interface Hop0Summary {
  readonly total: number;
  /** No observation gains a match skill. The claim "match-set neutral" means exactly this. */
  readonly matchSetNeutral: boolean;
  /** Above-floor landings on a skill the crosswalk never named. Taxonomy-correctness defects. */
  readonly misassignments: readonly Hop0Observation[];
  /** Phrases that stop resolving. Coverage loss, no claim. */
  readonly coverageLosses: readonly Hop0Observation[];
  /** Observations whose neutrality depends on the floor rather than on the taxonomy. */
  readonly neutralOnlyViaFloor: number;
  /** Every match skill any phrase would newly confer, deduped. Empty iff `matchSetNeutral`. */
  readonly gainedMatchSkills: readonly string[];
}

export interface Hop0Input {
  readonly observation: Hop0Observation;
  readonly successorId: string | null;
  readonly subjectBridge: readonly string[];
  readonly landingBridge: readonly string[];
}

/**
 * Roll a set of observations into the verdict a decision document can quote.
 *
 * Deliberately reports the three consequences SEPARATELY rather than as one boolean. A
 * deprecation can be perfectly match-set neutral and still write the wrong skill onto a
 * worker's profile (D-7A) or silently stop resolving four phrases (D-7C's
 * `skill_cad_interpretation`). Collapsing them into "safe / unsafe" is what let the bridge
 * subtraction look sufficient in the first place.
 */
export function summarizeHop0(inputs: readonly Hop0Input[], floor: number): Hop0Summary {
  const misassignments: Hop0Observation[] = [];
  const coverageLosses: Hop0Observation[] = [];
  const gained = new Set<string>();
  let viaFloor = 0;

  for (const i of inputs) {
    const verdict = classifyLanding(i.observation, i.successorId, floor);
    if (verdict === "LANDS_ELSEWHERE_ABOVE_FLOOR") misassignments.push(i.observation);
    if (verdict === "FALLS_BELOW_FLOOR") coverageLosses.push(i.observation);

    const delta = matchSetDelta(i.subjectBridge, i.observation.ifSeeded, i.landingBridge, floor);
    for (const m of delta.gained) gained.add(m);
    if (delta.neutralOnlyViaFloor) viaFloor += 1;
  }

  return {
    total: inputs.length,
    matchSetNeutral: gained.size === 0,
    misassignments,
    coverageLosses,
    neutralOnlyViaFloor: viaFloor,
    gainedMatchSkills: [...gained].sort(),
  };
}

/**
 * The three skills D-7C would seed as deprecated — the set, in one place.
 *
 * It lives beside `D7C_SEED_EXCLUSIONS` because the two are halves of one decision: this list
 * is what the seed touches, that map is what it must never touch, and a reader who finds one
 * without the other will reconstruct the wrong scope. Exported so the audits share a single
 * definition rather than each carrying a copy that can drift.
 */
export const D7C_NEUTRAL_SUBJECTS: readonly string[] = [
  "skill_gdt_reading",
  "skill_cad_interpretation",
  "skill_dimensional_inspection",
];

/**
 * Skills that must NOT be included in the D-7C seed, and the measured reason.
 *
 * D-7C's three-vs-four split is load-bearing (see `d7a-boring-hold.md`). Encoded here rather
 * than left to a code comment so that a runner cannot quietly widen its own scope: the seed
 * instrument asserts against this list, and a test asserts the list still contains boring.
 */
export const D7C_SEED_EXCLUSIONS: Readonly<Record<string, string>> = {
  skill_boring:
    "D-7A, OWNER-HELD: seeding lands 'boring' on skill_drilling at 0.7556 — above the floor, " +
    "a different operation, and the corpus's named successor (skill_turning, 0.6652) would " +
    "not win. No option has been selected.",
};
