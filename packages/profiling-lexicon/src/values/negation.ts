/**
 * The negation engine — a faithful port of `signals._apply_negation` and its helpers.
 *
 * WHAT IT DOES: blanks out the words a negator denies, replacing them with SPACES so the string
 * keeps its LENGTH and every offset-based reader downstream (city spans, salary windows) is
 * unaffected. It also reports which TOPICS were negated.
 *
 * WHY IT EXISTS: without it, "abhi kaam nahi mil raha" becomes `availability: immediate` and
 * "VMC nahi chalaya" becomes a VMC operator. Both were measured, not imagined.
 *
 * All tuning lives in `data/negation.json` — the negator lists, the tag-negator rules, the
 * clause splitter, the look-back width and the negatable topic cues — so this file is the
 * ALGORITHM only and the Python side reads the identical data.
 *
 * OFFSETS. Python indexes by code point; JavaScript by UTF-16 code unit. They agree for
 * everything in this corpus: Latin and the Devanagari block are both BMP, so no surrogate pairs
 * occur. An emoji would diverge — which is one more reason the persona bans them and the pack
 * validator enforces that at build time.
 */

import { compilePattern, compilePatternGlobal, loadLexicon, type PatternSpec } from "../internal/regex.js";

interface NegationFile {
  readonly backWords: number;
  readonly tokenTrim: string;
  readonly wordScan: PatternSpec;
  readonly clauseSplit: PatternSpec;
  readonly negators: readonly string[];
  readonly tagOnlyNegators: readonly string[];
  readonly tagPreceders: readonly string[];
  readonly negatableTopicCues: readonly (PatternSpec & { readonly topic: string })[];
  readonly negationAnswersTopics: readonly string[];
}

const NEGATION = loadLexicon<NegationFile>("negation");

const BACK_WORDS = NEGATION.backWords;
const TOKEN_TRIM = new Set([...NEGATION.tokenTrim]);
const NEGATORS = new Set(NEGATION.negators);
const TAG_ONLY_NEGATORS = new Set(NEGATION.tagOnlyNegators);
const TAG_PRECEDERS = new Set(NEGATION.tagPreceders);

const TOPIC_CUES: readonly { topic: string; re: RegExp }[] = NEGATION.negatableTopicCues.map(
  (cue) => ({ topic: cue.topic, re: compilePattern(cue) }),
);

/** Topics where a DENIAL is itself a complete answer, so the ask is satisfied. */
export const NEGATION_ANSWERS_TOPICS: ReadonlySet<string> = new Set(
  NEGATION.negationAnswersTopics,
);

/** Result of running the negation engine over one message. */
export interface NegationResult {
  /** Same length as the input, with negated spans replaced by spaces. */
  readonly masked: string;
  /** Topics whose cue appeared inside a negated span. */
  readonly topics: ReadonlySet<string>;
  /** `[start, end)` offsets of each negated span, for callers that need to veto by overlap. */
  readonly spans: readonly (readonly [number, number])[];
}

/**
 * Python's `str.strip(chars)` — remove every leading and trailing character that is in the set.
 * JavaScript's `trim()` only handles whitespace, so "nahi," would tokenize as "nahi," and never
 * match the negator list.
 */
function stripChars(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && TOKEN_TRIM.has(token[start] as string)) start += 1;
  while (end > start && TOKEN_TRIM.has(token[end - 1] as string)) end -= 1;
  return token.slice(start, end);
}

/** `(start, end)` of each clause, splitters excluded. Mirrors `signals._clause_bounds`. */
function clauseBounds(text: string): (readonly [number, number])[] {
  const splitter = compilePatternGlobal(NEGATION.clauseSplit);
  const bounds: (readonly [number, number])[] = [];
  let cursor = 0;
  for (const sep of text.matchAll(splitter)) {
    const start = sep.index;
    if (start > cursor) bounds.push([cursor, start] as const);
    cursor = start + sep[0].length;
  }
  if (cursor < text.length) bounds.push([cursor, text.length] as const);
  return bounds;
}

/** Mirrors `signals._is_negator`. */
function isNegator(token: string, prevToken: string | null, isClauseFinal: boolean): boolean {
  if (NEGATORS.has(token)) return true;
  if (TAG_ONLY_NEGATORS.has(token)) {
    // Clause-final "na" is the affirmative tag ("VMC chalata hu na" = "I DO run VMC, right?"),
    // and "…hu na" is too. Treating either as a denial would delete the very machine the
    // worker just claimed.
    return !isClauseFinal && !TAG_PRECEDERS.has(prevToken ?? "");
  }
  return false;
}

/**
 * Blank out negated spans and report which topics were negated.
 *
 * Faithful port of `signals._apply_negation`, including the detail that makes it safe: masking
 * writes SPACES at the same indices rather than deleting, so the returned string has the same
 * length as the input and every offset computed against the original still lines up.
 */
export function applyNegation(text: string): NegationResult {
  if (!text) return { masked: text, topics: new Set(), spans: [] };

  const chars = [...text];
  const spans: (readonly [number, number])[] = [];

  for (const [clauseStart, clauseEnd] of clauseBounds(text)) {
    const scanner = compilePatternGlobal(NEGATION.wordScan);
    const words: { start: number; end: number; token: string }[] = [];
    for (const m of text.slice(clauseStart, clauseEnd).matchAll(scanner)) {
      words.push({
        start: m.index + clauseStart,
        end: m.index + m[0].length + clauseStart,
        token: stripChars(m[0]).toLowerCase(),
      });
    }

    for (let i = 0; i < words.length; i += 1) {
      const prevToken = i > 0 ? (words[i - 1] as { token: string }).token : null;
      const current = words[i] as { token: string };
      if (!isNegator(current.token, prevToken, i === words.length - 1)) continue;

      const back = words.slice(Math.max(0, i - BACK_WORDS), i);
      if (back.length === 0) continue;
      spans.push([
        (back[0] as { start: number }).start,
        (back[back.length - 1] as { end: number }).end,
      ] as const);
    }
  }

  const topics = new Set<string>();
  for (const [start, end] of spans) {
    const spanText = text.slice(start, end);
    for (const cue of TOPIC_CUES) if (cue.re.test(spanText)) topics.add(cue.topic);
    for (let k = start; k < end; k += 1) chars[k] = " ";
  }

  return { masked: chars.join(""), topics, spans };
}

/**
 * Was the span `[start, end)` negated?
 *
 * Exposed because the orchestrator needs it directly for chip answers: a tapped chip is the
 * worker's answer of record verbatim, and a free-text answer that negates a chip label must
 * beat it.
 *
 * Overlap, not containment: a negated span blanks whole tokens, and a value span can start
 * mid-token (the digits inside "25000/mahina"), so requiring full containment would miss it.
 */
export function isNegated(text: string, span: { start: number; end: number }): boolean {
  return applyNegation(text).spans.some(([s, e]) => s < span.end && span.start < e);
}
