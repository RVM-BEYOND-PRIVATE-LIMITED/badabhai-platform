/**
 * Confidence calibration — turning four incomparable scores into one decidable number.
 *
 * THE PROBLEM THIS SOLVES. The retrieval ladder produces scores from four different
 * mechanisms: L0 is a hash hit (no score at all), L1 is a hash hit on a lossy key, L2 is
 * `word_similarity` from pg_trgm, L3 is cosine distance from pgvector. A trigram 0.7 and a
 * cosine 0.7 are not the same evidence and never were — trigram similarity is bounded by
 * shared character n-grams and saturates early, cosine on a 768-dim embedding is roughly
 * normal around 0.6 for unrelated text. Thresholding them with one number without mapping
 * them first is the mistake that makes a matcher "mysteriously" accept junk from one layer
 * and reject good hits from another.
 *
 * So each layer is mapped onto a shared `confidence ∈ [0,1]` by a piecewise-linear table,
 * and ONE threshold set is applied to the mapped value regardless of which layer produced
 * it. The tables live here as data rather than in a config file for now because they are
 * not yet calibrated against real utterances — Phase 9 owns that, and moving them to
 * `packages/config` before there is anything to calibrate FROM would give false comfort.
 *
 * THE NUMBERS ARE PROVISIONAL AND SAID SO. The plan's `0.55/0.88/0.08` vector thresholds
 * are preserved underneath as the raw vector-layer anchors, and everything else is an
 * engineering estimate stated in one place so Phase 9 can move it in one place.
 *
 * PRECISION IS ASYMMETRIC HERE, which is why the floors are high. A wrong family does not
 * cost one bad answer — it selects the wrong question pack, so every subsequent question
 * in the interview is about the wrong trade. One extra clarifying turn is cheap; twelve
 * questions about welding for a tailor is an abandoned interview.
 */

/** Which layer produced a candidate. Ordered cheapest-first, exactly as the ladder runs. */
export type RetrievalLayer = "L0" | "L1" | "L2" | "L3";

/**
 * Layer → confidence, as piecewise-linear anchor points on the layer's RAW score.
 *
 * L0 has no raw score: an exact normalized-alias hit either happened or did not, and it is
 * the strongest evidence the system can have short of the worker tapping a chip — the
 * worker used a name somebody reviewed and attached to this occupation. It is a constant.
 *
 * L1 is the same hit through a lossy key, so it is strong but not certain: the skeleton
 * fold collapses `driver`/`drover` and `fitter`/`father`, which is exactly why L0 is
 * exhausted first and why L1 lands below the auto floor on its own.
 */
const ANCHORS: Record<RetrievalLayer, readonly (readonly [raw: number, confidence: number])[]> = {
  // Constant: exact match, no raw score to interpolate over.
  L0: [[0, 0.97], [1, 0.97]],
  // Constant, deliberately BELOW AUTO_FLOOR — a skeleton hit alone must not auto-pin.
  L1: [[0, 0.72], [1, 0.72]],
  // pg_trgm word_similarity. Below ~0.35 it is noise (two words sharing "ing"); it
  // saturates around 0.9 where the strings differ only by punctuation.
  L2: [
    [0.0, 0.0],
    [0.35, 0.30],
    [0.55, 0.55],
    [0.75, 0.74],
    [0.9, 0.82],
    [1.0, 0.86],
  ],
  // Cosine SIMILARITY (1 - distance). The plan's vector anchors: 0.55 is the floor below
  // which a vector hit is discarded, 0.88 is where it is trusted outright.
  L3: [
    [0.0, 0.0],
    [0.55, 0.45],
    [0.7, 0.62],
    [0.88, 0.86],
    [1.0, 0.92],
  ],
};

/**
 * AUTO-PIN needs BOTH a floor and a margin, and the margin is the one that matters.
 *
 * A floor alone accepts the top candidate whenever it scores well — including when the
 * runner-up scores just as well, which is precisely the ambiguous case where guessing is
 * worst. `mistri` legitimately reaches masonry and general repair; both score high; picking
 * either silently is how a mason gets an interview about motorcycle engines.
 */
export const AUTO_FLOOR = 0.8;
export const AUTO_MARGIN = 0.12;

/** Below this, nothing is offered — the phrase is recorded unresolved and the engine broadens. */
export const DISAMBIGUATE_FLOOR = 0.45;

/** Most chips a worker should ever be shown, before the "Kuch aur" escape. */
export const MAX_DISAMBIGUATION_OPTIONS = 4;

/**
 * Map a raw layer score onto the shared confidence scale.
 *
 * Clamps rather than extrapolates at both ends: an out-of-range score is a bug in the
 * caller, and extrapolating one would silently produce a confidence above 1 that then
 * passes every threshold.
 */
export function calibrate(layer: RetrievalLayer, rawScore: number): number {
  const anchors = ANCHORS[layer];
  const first = anchors[0]!;
  const last = anchors[anchors.length - 1]!;
  if (!Number.isFinite(rawScore)) return 0;
  if (rawScore <= first[0]) return first[1];
  if (rawScore >= last[0]) return last[1];
  for (let i = 1; i < anchors.length; i++) {
    const [x1, y1] = anchors[i]!;
    const [x0, y0] = anchors[i - 1]!;
    if (rawScore <= x1) {
      const span = x1 - x0;
      // Guard a zero-width segment rather than dividing by it — a duplicated anchor x is
      // an authoring slip, not a reason to return NaN into a threshold comparison.
      if (span === 0) return y1;
      return y0 + ((rawScore - x0) / span) * (y1 - y0);
    }
  }
  return last[1];
}

export type MatchDecision = "auto" | "disambiguate" | "unresolved";

export interface ScoredCandidate {
  jobDomainId: string;
  /** The family this occupation resolves to. The margin is computed on THIS, not the id. */
  familyId: string | null;
  confidence: number;
  layer: RetrievalLayer;
}

export interface DecisionResult {
  decision: MatchDecision;
  /** Set only when `decision === "auto"`. */
  pinned: ScoredCandidate | null;
  /** Set only when `decision === "disambiguate"`, already truncated and de-duplicated. */
  options: ScoredCandidate[];
  /** Why the engine did what it did. Logged; never shown to a worker. */
  reason: string;
}

/**
 * Decide what to do with a scored candidate list.
 *
 * THE MARGIN IS COMPUTED AT FAMILY LEVEL, and this is the single most important line in
 * the file. NCO unit 7223 holds 44 near-identical machining titles: at OCCUPATION level the
 * top two are separated by ~0.02 and no margin rule can ever fire, so a family-blind
 * matcher either never auto-pins or auto-pins a coin flip. At FAMILY level those 44 titles
 * are one candidate, the margin is against a genuinely different trade, and the exact
 * occupation is settled afterwards by the pack's own first question — for free, in the
 * worker's own words.
 *
 * Candidates are assumed sorted by confidence descending; the function does not re-sort,
 * because the caller's ordering also carries the ladder's layer precedence and re-sorting
 * here would silently discard it.
 */
export function decide(candidates: readonly ScoredCandidate[]): DecisionResult {
  const top = candidates[0];
  if (top === undefined) {
    return { decision: "unresolved", pinned: null, options: [], reason: "no candidates" };
  }
  if (top.confidence < DISAMBIGUATE_FLOOR) {
    return {
      decision: "unresolved",
      pinned: null,
      options: [],
      reason: `top confidence ${top.confidence.toFixed(3)} < DISAMBIGUATE_FLOOR ${DISAMBIGUATE_FLOOR}`,
    };
  }

  // The best candidate from a DIFFERENT family. Same-family runners-up are not rivals —
  // they resolve to the same pack, so choosing between them is not a decision the engine
  // has to make correctly.
  const rival = candidates.find(
    (c) => c.familyId !== top.familyId || (c.familyId === null && top.familyId === null && c !== top),
  );
  const margin = rival === undefined ? 1 : top.confidence - rival.confidence;

  if (top.confidence >= AUTO_FLOOR && margin >= AUTO_MARGIN) {
    return {
      decision: "auto",
      pinned: top,
      options: [],
      reason: `confidence ${top.confidence.toFixed(3)} >= ${AUTO_FLOOR}, family margin ${margin.toFixed(3)} >= ${AUTO_MARGIN}`,
    };
  }

  // One chip per FAMILY: two chips that lead to the same interview are the same chip as
  // far as the worker is concerned, and showing both wastes the four slots available.
  const seen = new Set<string>();
  const options: ScoredCandidate[] = [];
  for (const c of candidates) {
    if (c.confidence < DISAMBIGUATE_FLOOR) break;
    const key = c.familyId ?? `jd:${c.jobDomainId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(c);
    if (options.length >= MAX_DISAMBIGUATION_OPTIONS) break;
  }

  if (options.length < 2) {
    // A single option that did not clear the auto bar is not a choice — offering one chip
    // asks the worker to confirm a guess we are not confident enough to make.
    return {
      decision: "unresolved",
      pinned: null,
      options: [],
      reason:
        top.confidence < AUTO_FLOOR
          ? `confidence ${top.confidence.toFixed(3)} < AUTO_FLOOR and only one family above the floor`
          : `family margin ${margin.toFixed(3)} < AUTO_MARGIN but only one family above the floor`,
    };
  }

  return {
    decision: "disambiguate",
    pinned: null,
    options,
    reason:
      top.confidence < AUTO_FLOOR
        ? `confidence ${top.confidence.toFixed(3)} < AUTO_FLOOR ${AUTO_FLOOR}`
        : `family margin ${margin.toFixed(3)} < AUTO_MARGIN ${AUTO_MARGIN}`,
  };
}
