/**
 * §5a-2 — the sibling margin, as arithmetic. No policy, no threshold, no decision.
 *
 * ===========================================================================
 * THE QUESTION THE OWNER WAS HANDED
 * ===========================================================================
 * 11 within-domain sibling pairs score above the 0.75 floor after every corpus decision on the
 * table. Nothing is misassigned today — the correct alias wins each one — so what has been lost
 * is **margin**: the floor no longer separates a right answer from its nearest wrong sibling.
 * Three options were recorded, and choosing between them is a product decision:
 *
 *   A  accept the margin and rely on the correct alias winning
 *   B  require a minimum SEPARATION between the top two, not only an absolute floor
 *   C  treat lexically-close siblings as a disambiguation group with an explicit tie-break
 *
 * ===========================================================================
 * WHAT THIS MODULE DOES INSTEAD OF CHOOSING
 * ===========================================================================
 * Every one of those options is a claim about numbers that can be measured now:
 *
 *   For B — is there a separation δ that rejects wrong answers without throwing away right
 *           ones? That is two distributions and a sweep, and the answer might be "no δ works",
 *           which is a finding, not a preference.
 *   For C — would a LEXICAL rule even catch the pairs that matter? `TIG welding`/`MIG welding`
 *           share a token; `GMAW`/`SMAW` share nothing, and they are the worst pair at 0.8405.
 *           A rule that misses its own headline case is worth knowing about before anyone
 *           adopts it.
 *   For A — accepting a margin means accepting a specific number of specific pairs, and they
 *           should be named.
 *
 * Pure functions only. The instrument that feeds them lives in `audit-sibling-margin.ts`.
 */

/** One leave-one-out retrieval result: what a probe found once its own row was removed. */
export interface MarginObservation {
  readonly phrase: string;
  readonly domain: string;
  readonly ownSkill: string;
  /** Best score from the probe's OWN skill (via a different alias). Null if it has no other. */
  readonly ownScore: number | null;
  /** Best score from ANY other skill in scope. Null if the scope holds no other skill. */
  readonly otherSkill: string | null;
  readonly otherScore: number | null;
  readonly otherVia: string | null;
}

/**
 * What a resolution policy would do with one observation.
 *
 * `UNMEASURABLE` is not a failure of the probe — it is a skill with only one alias, whose
 * leave-one-out corpus no longer represents it at all. Scoring those as misses would report a
 * retrieval defect where there is only a thin corpus, and there are enough of them to move a
 * headline number.
 */
export type MarginOutcome =
  | "CORRECT"
  | "WRONG"
  | "UNRESOLVED"
  | "UNMEASURABLE";

/**
 * Classify one observation under a floor and a minimum separation.
 *
 * `separation = 0` reproduces the CURRENT policy exactly, which is why the sweep can include it
 * as its own baseline rather than describing today's behaviour from a second code path.
 */
export function classifyMargin(
  o: MarginObservation,
  floor: number,
  separation: number,
): MarginOutcome {
  if (o.ownScore === null) return "UNMEASURABLE";
  const own = o.ownScore;
  const other = o.otherScore ?? -1;
  const top = Math.max(own, other);
  if (top < floor) return "UNRESOLVED";
  // A separation rule rejects when the top two are too close, whichever of them is correct.
  // Applying it only when the answer is wrong would be a rule that already knows the answer.
  if (Math.abs(own - other) < separation) return "UNRESOLVED";
  return own >= other ? "CORRECT" : "WRONG";
}

export interface SweepPoint {
  readonly separation: number;
  readonly correct: number;
  readonly wrong: number;
  readonly unresolved: number;
  /** Right answers a separation rule throws away that the floor alone would have kept. */
  readonly lostCorrect: number;
  /** Wrong answers it rejects that the floor alone would have assigned. */
  readonly rejectedWrong: number;
}

/**
 * Sweep the separation parameter, always measured against separation = 0.
 *
 * The two derived columns are the whole point: a threshold is only interesting as a TRADE, and
 * reporting "wrong answers rejected" without "right answers lost" is how a threshold gets
 * chosen for one number.
 */
export function sweepSeparation(
  observations: readonly MarginObservation[],
  floor: number,
  separations: readonly number[],
): SweepPoint[] {
  const baseline = observations.map((o) => classifyMargin(o, floor, 0));
  return separations.map((separation) => {
    let correct = 0;
    let wrong = 0;
    let unresolved = 0;
    let lostCorrect = 0;
    let rejectedWrong = 0;
    observations.forEach((o, i) => {
      const v = classifyMargin(o, floor, separation);
      if (v === "CORRECT") correct += 1;
      else if (v === "WRONG") wrong += 1;
      else if (v === "UNRESOLVED") {
        unresolved += 1;
        if (baseline[i] === "CORRECT") lostCorrect += 1;
        if (baseline[i] === "WRONG") rejectedWrong += 1;
      }
    });
    return { separation, correct, wrong, unresolved, lostCorrect, rejectedWrong };
  });
}

/**
 * The smallest separation that rejects EVERY wrong answer, and null when none does.
 *
 * Null is the interesting answer. It means the wrong answers are not merely close to the right
 * ones — some are further from their runner-up than some right answers are, so no single
 * separation orders them apart. Exactly the shape the 0.75 floor already has for single-word
 * vernacular.
 */
export function separatingSeparation(
  observations: readonly MarginObservation[],
  floor: number,
  candidates: readonly number[],
): number | null {
  for (const s of candidates) {
    const pts = sweepSeparation(observations, floor, [s]);
    if (pts[0]!.wrong === 0) return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// OPTION C — would a lexical rule find these pairs at all?
// ---------------------------------------------------------------------------

/** Words a shared-token rule must ignore, or every welding alias groups with every other. */
const STOPWORDS = new Set(["the", "a", "of", "and", "ka", "kaam", "karna", "se"]);

/**
 * Devanagari counts as word characters — 12 of the 22 ratified vernacular aliases are written in
 * it, and a splitter that treats the script as punctuation tokenises them to nothing.
 *
 * `\p{Script=Devanagari}` rather than a codepoint range: the block starts at U+0900, a combining
 * mark, and a range anchored on one is ambiguous about codepoints versus grapheme clusters —
 * `no-misleading-character-class` is right to reject it. The script property says what is meant.
 */
export const tokens = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\p{Script=Devanagari}]+/gu, " ")
    .split(" ")
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));

/**
 * Do two phrases share a content token?
 *
 * The mechanical form of "lexically close". Deliberately the SIMPLEST such rule, because the
 * question is whether the simple version suffices — not whether some rule could be built that
 * works.
 */
export function sharesToken(a: string, b: string): boolean {
  const A = new Set(tokens(a));
  return tokens(b).some((t) => A.has(t));
}

export interface LexicalCoverage {
  readonly caught: readonly string[];
  readonly missed: readonly string[];
  readonly worstIsMissed: boolean;
}

/**
 * Which above-floor sibling pairs a shared-token rule would actually group.
 *
 * `worstIsMissed` is the headline: if the highest-scoring pair is invisible to the rule, the
 * rule does not address the finding it was proposed for.
 */
export function lexicalCoverage(
  pairs: readonly { phrase: string; via: string; score: number }[],
): LexicalCoverage {
  const sorted = [...pairs].sort((a, b) => b.score - a.score);
  const caught: string[] = [];
  const missed: string[] = [];
  for (const p of sorted) {
    (sharesToken(p.phrase, p.via) ? caught : missed).push(`${p.phrase} / ${p.via}`);
  }
  const worst = sorted[0];
  return {
    caught,
    missed,
    worstIsMissed: worst !== undefined && !sharesToken(worst.phrase, worst.via),
  };
}
