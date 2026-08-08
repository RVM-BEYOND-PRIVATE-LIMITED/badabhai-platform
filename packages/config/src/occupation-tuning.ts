/**
 * Occupation-retrieval tuning — the calibration curve and the decision thresholds.
 *
 * WHY THIS IS IN `@badabhai/config` AND NOT BESIDE THE MATCHER. The plan requires the
 * piecewise-linear table to live as config precisely so Phase 9 can re-calibrate it in ONE
 * place after measuring production utterances, without touching retrieval logic. A table
 * that lives next to the code that reads it invites a "quick tweak" in the same commit as a
 * behaviour change, and then nobody can tell which of the two moved the number.
 *
 * WHY IT IS A CONSTANT AND NOT ENV-DERIVED, which is the awkward part of living in a package
 * whose other modules are all `process.env` schemas. These values decide which occupation a
 * worker is assigned. Env-tuning them would let staging and production disagree about the
 * same worker's trade, and a calibration measured in one environment would be meaningless in
 * the other. A change here is a reviewed code change, deliberately.
 *
 * THE NUMBERS ARE PROVISIONAL AND SAY SO. They are engineering estimates, not measurements —
 * Phase 9 owns replacing them with a sweep against real utterances. The plan's original
 * vector thresholds (0.55 / 0.88) survive as the raw L3 anchor points underneath.
 */

/** Which layer of the retrieval ladder produced a candidate. Cheapest-first. */
export const RETRIEVAL_LAYERS = ["L0", "L1", "L2", "L3"] as const;
export type RetrievalLayer = (typeof RETRIEVAL_LAYERS)[number];

/** One anchor point: a raw layer score, and the shared confidence it maps to. */
export type CalibrationAnchor = readonly [raw: number, confidence: number];

/**
 * Layer → confidence, as piecewise-linear anchor points on the layer's RAW score.
 *
 * A trigram 0.7 and a cosine 0.7 are not the same evidence and never were: trigram
 * similarity is bounded by shared character n-grams and saturates early, while cosine on a
 * 768-dim embedding sits around 0.6 for unrelated text. Thresholding both with one number
 * without mapping them first is what makes a matcher "mysteriously" accept junk from one
 * layer and reject good hits from another.
 *
 * L0 has no raw score — an exact normalized-alias hit either happened or did not, and it is
 * the strongest evidence short of the worker tapping a chip. It is a constant.
 *
 * L1 is the same hit through a LOSSY key, so it is strong but not certain: the skeleton fold
 * collapses `driver`/`drover` and `fitter`/`father`. Deliberately below `AUTO_FLOOR`, so a
 * skeleton hit never auto-pins on its own.
 */
export const CALIBRATION_ANCHORS: Readonly<Record<RetrievalLayer, readonly CalibrationAnchor[]>> = {
  L0: [
    [0, 0.97],
    [1, 0.97],
  ],
  L1: [
    [0, 0.72],
    [1, 0.72],
  ],
  // pg_trgm word_similarity. Below ~0.35 it is noise (two words sharing "ing"); it saturates
  // near 0.9 where the strings differ only by punctuation.
  L2: [
    [0.0, 0.0],
    [0.35, 0.3],
    [0.55, 0.55],
    [0.75, 0.74],
    [0.9, 0.82],
    [1.0, 0.86],
  ],
  // Cosine SIMILARITY (1 - distance). The plan's vector anchors survive here: 0.55 is the
  // floor below which a vector hit is discarded, 0.88 where it is trusted outright.
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
 *
 * PRECISION IS ASYMMETRIC HERE, which is why the floor is high. A wrong family does not cost
 * one bad answer — it selects the wrong question pack, so every later question is about the
 * wrong trade. One extra clarifying turn is cheap; twelve welding questions for a tailor is
 * an abandoned interview.
 */
export const AUTO_FLOOR = 0.8;
export const AUTO_MARGIN = 0.12;

/** Below this, nothing is offered — the phrase is recorded unresolved and the engine broadens. */
export const DISAMBIGUATE_FLOOR = 0.45;

/** Most chips a worker should ever be shown, before the "Kuch aur" escape. */
export const MAX_DISAMBIGUATION_OPTIONS = 4;

/**
 * The escape hatch on every disambiguation offer.
 *
 * WITHOUT IT THE OFFER IS A TRAP. Four chips and no way out forces a worker whose trade is
 * not among them to tap one anyway — and the chip label becomes their answer of record
 * verbatim, so a wrong tap is indistinguishable from a right one for the rest of the
 * interview. The escape is what makes "none of these" expressible.
 */
export const DISAMBIGUATION_ESCAPE_KEY = "kuch_aur";
export const DISAMBIGUATION_ESCAPE_LABEL = "Kuch aur";
