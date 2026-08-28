import { looksLikePii } from "@badabhai/validators";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════
 * "IN THE WORKER'S OWN WORDS" — §8.4's verbatim block, and the one place a worker's voice
 * reaches the page.
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * WHAT THE GUIDELINE ACTUALLY ASKS FOR. §8 names exactly three sources for every printed
 * string: "a closed vocabulary label, a number the worker stated, or the worker's own words
 * rendered verbatim. There is no fourth source." §8.4 gives this block its job — below the
 * ~0.75 confidence floor a phrase does not become a canonical tag, but "it may still print
 * verbatim on the resume as the worker's own words, which is honest and is what makes
 * off-wedge resumes possible on day one."
 *
 * WHY THE SLOT EXISTED FOR A MONTH WITH NOTHING BEHIND IT. `ResumeRenderInput.ownWords` and
 * `{{#own_words}}` both landed with the sheet, and the slot's own docstring set a bar nothing
 * could clear: it "must arrive as a stored transcript fragment rather than as anything a model
 * wrote". The only per-phrase text on the render path is the extraction container's, which IS
 * something a model wrote — so the honest move was to render nothing, and nothing is what
 * every worker got.
 *
 * ── THE MECHANISM: THE MODEL PROPOSES, THE TRANSCRIPT DISPOSES ────────────────────────
 *
 * Both halves of the bar are satisfiable at once, by separating them:
 *
 *   CANDIDATES come from the extraction. Choosing which of a worker's sentences says
 *   something about his trade is exactly the job §8 licenses the model to do — extract,
 *   normalise, classify. It is not composition.
 *
 *   THE VETO comes from the stored transcript. A candidate prints only when it occurs
 *   VERBATIM inside something the worker actually typed or said. That turns "verbatim" from
 *   a claim about the prompt into a property this function checks, phrase by phrase, against
 *   bytes the model never touched.
 *
 * It is not theoretical. On the R7 persona run the model returned seven sentences for the
 * two-year operator; six are literal fragments of his turns and one — "Vernier aur micrometer,
 * plug gauge use karta hoon" — is a fusion of two separate answers with a verb he never used.
 * The veto drops exactly that one. Nothing else on the sheet could have caught it.
 *
 * NOT A SAFETY GATE FOR PII, and it must not be mistaken for one. The transcript is raw worker
 * text: it contains his employer, his city, sometimes his name. `looksLikePii` runs here as the
 * same backstop it is everywhere else on this path, and the length window plus the enumeration
 * rule do most of the narrowing. The real guarantee is that these phrases are short trade
 * statements the model already selected for trade content.
 */

/** How many quotes the block may print. Three is what the design's inline row holds. */
export const OWN_WORDS_MAX = 3;

/**
 * The length window, in characters.
 *
 * SHORT ENOUGH TO BE A QUOTE, LONG ENOUGH TO SAY SOMETHING. The template renders each phrase
 * as an `inline-block` list item inside one row, so a 200-character sentence stops being a
 * quote and becomes a paragraph that eats the page. Below the floor a fragment is a filler
 * ("haan sir", "theek hai") that costs a line and carries nothing.
 */
export const OWN_WORDS_MIN_CHARS = 18;
export const OWN_WORDS_MAX_CHARS = 110;

/** Sentence terminators. Devanagari danda included; the comma deliberately is NOT. */
const SENTENCE_SPLIT_RE = /[.!?;।॥\n\r]+/;

/** Comparison form: case-folded, whitespace-collapsed, edge punctuation removed. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s.,;:!?"'‘’“”।॥-]+/, "")
    .replace(/[\s.,;:!?"'‘’“”।॥-]+$/, "")
    .trim();
}

/**
 * Split extracted prose into the phrases the block prints.
 *
 * ON SENTENCES, NEVER ON COMMAS. "Facing, turning, drilling, grooving" is one thing the worker
 * said; splitting it into four would manufacture four quotes out of one sentence, and each
 * fragment would then also fall under the length floor and vanish — so the effect would be to
 * silently delete his most concrete answer rather than to print it.
 */
export function splitIntoPhrases(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * True when every comma-separated segment of the phrase is already printed elsewhere.
 *
 * THE DUPLICATION THIS CATCHES IS REAL AND SPECIFIC. The model's narrative repeats the skills
 * it also emitted as tags — "Facing, turning, drilling, grooving" against the chips `facing`,
 * `turning`, `drilling`, `grooving`. Printing it again in quotes adds a line and no information.
 *
 * SEGMENT-WISE RATHER THAN BY CONTAINMENT, and that distinction is the whole rule. A containment
 * test ("does the phrase contain a printed skill?") would kill "CNC lathe chalata hoon" because
 * `CNC lathe operation` is a chip — i.e. it would delete every sentence that mentions the trade,
 * which is every sentence worth printing. Requiring EVERY segment to be a printed label means
 * only a bare enumeration is dropped, and any sentence carrying a verb survives.
 */
export function isEnumerationOfPrinted(phrase: string, printed: ReadonlySet<string>): boolean {
  const segments = phrase
    .split(",")
    .map((s) => normalizeForMatch(s))
    .filter((s) => s.length > 0);
  if (segments.length === 0) return false;
  return segments.every((s) => printed.has(s));
}

export interface OwnWordsSelection {
  /** The phrases that may print, in the order the worker said them. */
  readonly phrases: string[];
  /**
   * Candidates the transcript did NOT vouch for.
   *
   * RETURNED RATHER THAN DISCARDED because it is the only measurement of how often the model
   * composes rather than quotes, and it is measured per render on real workers. A caller that
   * ignores it loses nothing; the harness reports it.
   */
  readonly notVerbatim: string[];
}

/**
 * Select the quotable phrases: model-proposed, transcript-vouched, de-duplicated, PII-screened.
 *
 * PURE. No clock, no I/O, no model. The caller supplies the stored transcript; this decides.
 */
export function selectOwnWords(args: {
  /** Extraction prose — `experiences[].work_done` and the like. */
  readonly candidates: readonly (string | null | undefined)[];
  /** The worker's OWN stored turns, verbatim. Nothing the assistant said. */
  readonly workerSaid: readonly string[];
  /** Everything the sheet already prints — skill chips, capability values, work lines. */
  readonly alreadyPrinted: readonly string[];
  readonly max?: number;
}): OwnWordsSelection {
  const said = args.workerSaid
    .map((t) => normalizeForMatch(t))
    .filter((t) => t.length > 0);
  const printed = new Set(args.alreadyPrinted.map((p) => normalizeForMatch(p)).filter(Boolean));

  const phrases: string[] = [];
  const notVerbatim: string[] = [];
  const seen = new Set<string>();

  for (const candidate of args.candidates) {
    if (!candidate) continue;
    for (const phrase of splitIntoPhrases(candidate)) {
      if (phrase.length < OWN_WORDS_MIN_CHARS || phrase.length > OWN_WORDS_MAX_CHARS) continue;
      const key = normalizeForMatch(phrase);
      if (!key || seen.has(key)) continue;
      // THE VETO, and it runs before every other filter so `notVerbatim` counts what the model
      // composed rather than what the page had no room for.
      if (!said.some((turn) => turn.includes(key))) {
        notVerbatim.push(phrase);
        continue;
      }
      seen.add(key);
      if (printed.has(key)) continue;
      if (isEnumerationOfPrinted(phrase, printed)) continue;
      if (looksLikePii(phrase)) continue;
      phrases.push(phrase);
    }
  }

  return { phrases: phrases.slice(0, args.max ?? OWN_WORDS_MAX), notVerbatim };
}
