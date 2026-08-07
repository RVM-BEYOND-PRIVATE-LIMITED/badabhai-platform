/**
 * YES / NO for a Hinglish boolean answer.
 *
 * WHY THIS EXISTS. 236 of the 466 authored question-pack items are `answer_type: "boolean"`, and
 * measured against the corpus, **every one of them carries zero options**. There is no chip to tap
 * and no label to match — only a sentence. Without this the capture layer fell through to its
 * verbatim path and wrote "haan bilkul karta hoon" into a field whose whole vocabulary is
 * `true` / `false`.
 *
 * THE NEGATIVE HALF IS NOT DEFINED HERE. It is `negation.json`'s negator lists, read through the
 * negation engine in `negation.ts`. That is not tidiness: the engine already knows about clause
 * splitting and the look-back window that decides whether a negator actually REACHES a given word,
 * and "kaam nahi mil raha, gas charging karta hoon" has to keep its yes. A second list of ways to
 * say "no" is a second thing that would have to learn all of that again.
 *
 * FAIL CLOSED. `null` means "this is not a yes-or-no answer" — never a guessed `false`. A boolean
 * question answered with "kabhi kabhi" is genuinely ambiguous, and the caller's correct response is
 * to leave the question askable, not to record something the worker did not say into a column the
 * matcher will filter on.
 */

import { compilePatternGlobal, loadLexicon, type PatternSpec } from "../internal/regex.js";
import { isNegated, precededByNegator } from "./negation.js";
import type { NormalizedValue } from "./types.js";

interface AffirmationFile {
  readonly explicitCues: readonly PatternSpec[];
  readonly verbCues: readonly PatternSpec[];
  readonly standaloneNegatives: readonly string[];
}

const FILE = loadLexicon<AffirmationFile>("affirmation");
const EXPLICIT = FILE.explicitCues.map((spec) => compilePatternGlobal(spec));
const VERB = FILE.verbCues.map((spec) => compilePatternGlobal(spec));

/**
 * How far back a negator reaches when deciding whether an affirmative cue is denied.
 *
 * Two tokens, deliberately narrower than the negation engine's own window. A yes/no answer is
 * short and its negator sits right next to it — "nahi karta", "haan nahi" — while a wider window
 * starts letting an unrelated earlier negation ("paisa nahi mila, haan yeh karta hoon") flip a
 * genuine yes.
 */
const NEGATOR_LOOKBACK = 2;

interface CueHit {
  readonly start: number;
  readonly end: number;
}

/** The earliest non-empty match of any pattern in the set, or null. */
function firstHit(text: string, patterns: readonly RegExp[]): CueHit | null {
  let best: CueHit | null = null;
  for (const pattern of patterns) {
    // A fresh scan per pattern: `compilePatternGlobal` returns a sticky-free global regex whose
    // `lastIndex` persists across calls, so `matchAll` (which clones) is the only safe iterator.
    for (const match of text.matchAll(pattern)) {
      // An EMPTY match is not evidence of anything. A pattern whose whole body is optional matches
      // at every offset, and treating that as a cue would report a yes in any text at all.
      if (match[0].length === 0) continue;
      const start = match.index ?? 0;
      if (best === null || start < best.start) best = { start, end: start + match[0].length };
      break;
    }
  }
  return best;
}

/**
 * Read a boolean out of a Hinglish answer, or `null` when it is not one.
 *
 * THE ORDER OF THE THREE TIERS IS THE WHOLE ALGORITHM, and it was arrived at by watching two of
 * them fail:
 *
 * 1. **An explicit yes, if it survives negation.** "haan" wins over everything, unless a negator
 *    reaches it — "haan nahi, main nahi karta" is a `false`, and reading it as `true` would record
 *    the opposite of what the worker said into a column the matcher filters on.
 * 2. **A first-person verb claim**, likewise negation-checked. "karta hoon", "aata hai".
 * 3. **A bare negator, and only then.** "nahi" on its own.
 *
 * TIER 3 MUST COME LAST, and this is the ordering that measurement corrected. Put a negator scan
 * ahead of the verb tier and "kaam nahi mil raha, gas charging karta hoon" reads as a `false` — the
 * negator belongs to a clause about work, not to the answer. The verb tier's own negation check is
 * CLAUSE-CLAMPED (that is `precededByNegator`'s contract), so asking it first gets that sentence
 * right and still gets "nahi karta hoon" right.
 *
 * `negationVetoed` reports a veto rather than swallowing it: the value is a definite `false`
 * either way, but a diagnostic surface wants to know an affirmative cue was seen and why it lost.
 *
 * SCOPE. This runs on turns that have already passed `classifyUtterance` — `dont_know`,
 * `hardship`, `question_back` and `abusive` are diverted upstream and never arrive. That matters:
 * "pata nahi chalta" is a `dont_know`, not a `false`, and the division of labour is what keeps
 * this function from having to re-decide it.
 */
export function parseAffirmation(text: string): NormalizedValue<boolean> | null {
  const explicit = firstHit(text, EXPLICIT);
  if (explicit !== null) return withNegationCheck(text, explicit);

  const verb = firstHit(text, VERB);
  if (verb !== null) return withNegationCheck(text, verb);

  const negator = bareNegatorSpan(text);
  if (negator !== null) return { value: false, span: negator, negationVetoed: false };

  return null;
}

/** A cue is a yes unless a negator reaches it — clause-clamped, then span-overlap. */
function withNegationCheck(text: string, cue: CueHit): NormalizedValue<boolean> {
  const denied =
    precededByNegator(text, cue.start, NEGATOR_LOOKBACK) ||
    // `applyNegation` blanks the word a negator DENIES, which for a trailing negator is the word
    // BEFORE it — "bilkul nahi" masks "bilkul". The look-back above cannot see that, so both
    // checks are needed and neither is redundant.
    isNegated(text, { start: cue.start, end: cue.end });
  return { value: !denied, span: { start: cue.start, end: cue.end }, negationVetoed: denied };
}

const NEGATOR_SCAN = compilePatternGlobal({ source: "[^\\s]+", flags: "" });
const NEGATOR_TRIM = new Set([...".,!?;:।'\"()"]);

function bareNegatorSpan(text: string): { start: number; end: number } | null {
  for (const match of text.matchAll(NEGATOR_SCAN)) {
    const raw = match[0];
    const start = match.index ?? 0;
    let from = 0;
    let to = raw.length;
    while (from < to && NEGATOR_TRIM.has(raw[from] as string)) from += 1;
    while (to > from && NEGATOR_TRIM.has(raw[to - 1] as string)) to -= 1;
    const token = raw.slice(from, to).toLowerCase();
    if (token.length > 0 && NEGATOR_TOKENS.has(token)) {
      return { start: start + from, end: start + to };
    }
  }
  return null;
}

/**
 * The negator vocabulary, READ FROM `negation.json` rather than restated, plus the small set of
 * whole-utterance negatives that file deliberately does not carry.
 *
 * WHY THE SPLIT IS REAL AND NOT A LOOPHOLE. `negation.json`'s negators are SCOPING operators: the
 * engine blanks the words they deny. English "no" is not one — it is an answer token. Adding it
 * there would make "no. 5 gali" blank "5", in every detector, in both languages. So it lives here,
 * in the file about answering yes-or-no questions, and reaches nothing else.
 *
 * The tag-only negators ("na", "ना") are included. In the negation engine they are deliberately
 * weaker, because a trailing "na" is a tag question ("theek hai na?") rather than a denial. That is
 * safe here only because this tier is reached exclusively when no affirmative cue was found
 * anywhere — "theek hai na" has already been answered `true` by "theek" at tier 1.
 */
interface NegationVocabularyFile {
  readonly negators: readonly string[];
  readonly tagOnlyNegators: readonly string[];
}
const NEGATION_VOCABULARY = loadLexicon<NegationVocabularyFile>("negation");
const NEGATOR_TOKENS: ReadonlySet<string> = new Set([
  ...NEGATION_VOCABULARY.negators,
  ...NEGATION_VOCABULARY.tagOnlyNegators,
  ...FILE.standaloneNegatives,
]);
