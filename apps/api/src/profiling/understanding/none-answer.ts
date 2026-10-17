import type { QuestionPackItem } from "@badabhai/ai-contracts";
import { parseAffirmation } from "@badabhai/profiling-lexicon";

import { hasFieldNormalizer } from "../answer-capture";
import { isBareYesNo } from "../free-chat/free-chat.router";

/**
 * "I HAVE NONE" TO A FREE-TEXT QUESTION (#2328) — pure.
 *
 * THE DEFECT. A free-text question keeps the worker's words verbatim, so "maine koi course nahin
 * kiya" to "Aapne kaunsi training ya course ki hai?" became the training's NAME. That made the
 * question `answered`, and `answered` is what opens its follow-ups ("Training aapne kahan se ki
 * thi?", "Training kis saal ki thi?" — `ask_if: {op: "answered"}`).
 *
 * THE FIX IS HOW IT IS RECORDED, NOT A NEW RULE. Recorded DECLINED — a complete answer, never
 * re-asked — the question is not `answered`, and the pack's own `ask_if` skips every follow-up
 * (`predicate.ts`: "a follow-up conditioned on an answer has nothing to follow up on"). Owner
 * rulings 2026-10-16: every free-text question, not only training; the model reads a sentence
 * (`on_screen_none`, CLAUDE.md §3: it classifies, the pack's rule decides), and a BARE negative is
 * read here with no model at all, so it holds with the layer off and when the call fails.
 */

/**
 * A question whose answer is the worker's own words: text, with no typed parser for its field. A
 * typed field (a city, years) never stores a "nahi" — its parser reads no value and it is asked
 * again — and a yes/no question reads "nahi" as its answer.
 */
export function isFreeTextItem(item: QuestionPackItem): boolean {
  return item.answer_type === "text" && !hasFieldNormalizer(item.target_field);
}

/**
 * Quantifiers a "none" answer carries that are not themselves yes/no cues: "KOI nahi", "KUCH
 * nahi", "kabhi nahi". Set aside before the bare-answer check, which would otherwise read them as
 * content.
 */
const NONE_QUANTIFIERS = /(?<![\p{L}\p{N}])(koi|kuch|kabhi|bhi)(?![\p{L}\p{N}])/giu;

/**
 * The words a worker types around a "nahi" when the answer is "I did none", beyond the quantifiers
 * above: the spellings phones actually produce ("kuchh", "kucch", "kch"), the verb in the forms the
 * shared yes/no vocabulary does not carry ("kia", "kari", "liya", "की"), and the "I" that starts the
 * sentence ("maine", "मैंने"). Measured 2026-10-16: "kuch nahi koya", "nahi kia", "maine nahi
 * kiya", "कुछ नहीं", "नही की" all fell through to the model, which is not always on.
 *
 * KEPT HERE, NOT IN THE SHARED FILLER LIST (`TYPED_ANSWER_FILLER_WORDS`): that list also gates the
 * distress check, and a word added there lets a message ride an answer past it. These words are
 * set aside ONLY after `parseAffirmation` has read the answer as a "no".
 */
const NONE_WORDS =
  /(?<![\p{L}\p{N}\p{M}])(koi|kuch|kuchh|kucch|kch|kabhi|bhi|kiya|kia|kiye|kari|kara|kri|li|liya|maine|mene|mainne|कुछ|कोई|कभी|भी|किया|की|ली|लिया|मैंने)(?![\p{L}\p{N}\p{M}])/giu;

/** The verb a "none" ends on, for the one-typo read below. */
const NONE_VERBS: readonly string[] = ["kiya", "kia", "kari", "kara", "liya"];

/** Levenshtein distance, bounded to the short words it is used on. */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j] as number;
      row[j] = Math.min(
        above + 1,
        (row[j - 1] as number) + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return row[b.length] as number;
}

/**
 * The answer with every "none" word set aside — and, for a Latin word of 3-5 letters, the verb
 * one typo away ("koya", "kiyaa", "kiay"), the only reading a bare negative's last word has left.
 * A content word survives ("course", "ITI", "Tally"), so the answer stays content.
 */
function withoutNoneWords(text: string): string {
  return text
    .replace(NONE_WORDS, " ")
    .split(/(?<=[^\p{L}\p{M}])|(?=[^\p{L}\p{M}])/u)
    .map((part) =>
      /^[a-z]{3,5}$/i.test(part) &&
      NONE_VERBS.some((verb) => editDistance(part.toLowerCase(), verb) <= 1)
        ? " "
        : part,
    )
    .join("");
}

/** A whole answer that is only the English "none": "none", "nil", "nothing". */
const ENGLISH_NONE = /^\s*(none|nil|nothing)\s*[.!]*\s*$/i;

/**
 * A REFUSAL OF THE QUESTION ITSELF — "not interested", "mujhe interest nahi hai" — as opposed to
 * "I have none of it" (above). Owner ruling 2026-10-17: a refusal anywhere in the training trio
 * exits the whole group, and it must never be stored as the answer. Read for ANY question type
 * (the boolean gate included); the deterministic "none" reader above stays free-text-only because
 * a typed question's "nahi" is its real answer, not a refusal.
 *
 * WHOLE-MESSAGE ONLY ("bare"): carrying content ("not interested in welding, ITI turning kiya")
 * is a real sentence and the model's to read — the same strictness `isBareNone` keeps.
 */
const DECLINE_PATTERNS: readonly string[] = [
  "^(?:mujhe\\s+|main\\s+)?(?:(?:isme|is\\s*me|is\\s*mein|ye|yeh)\\s+)?" +
    "(?:(?:koi|bahut|zyada)\\s+)?" +
    "(?:not\\s+interest(?:ed)?|no\\s+interest|interest(?:ed)?\\s+nahi(?:n)?|nahi\\s+interest(?:ed)?)" +
    "(?:\\s+hai|\\s+ha|\\s+hu|\\s+hun)?[\\s.!,\\u0964]*$",
  "^(?:मुझे\\s+)?(?:इसमें\\s+|इस\\s+में\\s+)?(?:कोई\\s+)?(?:इंटरेस्ट|इंट्रेस्ट)\\s*नहीं(?:\\s+है)?" +
    "[\\s।.!]*$",
];
const DECLINE_RE = new RegExp(DECLINE_PATTERNS.join("|"), "iu");

/** Whether [text] is a BARE refusal of the question on screen, content-free and read with no model. */
export function isDeclineReply(text: string): boolean {
  return DECLINE_RE.test(text || "");
}

/**
 * Is this ONLY a "no"? "nahi", "nahi ki", "nahin kiya", "koi nahi", "kuch nahi", "kuch nahi koya",
 * "maine nahi kia", "कुछ नहीं", "none" — yes. Anything carrying content ("ITI nahi, private se
 * Tally kiya", "koi course nahi kiya"), a "pata nahi" (a don't-know, which the engine already
 * declines), and a negated state ("main theek nahi hoon", #2250 — `isBareYesNo` refuses it) — no.
 * Strict on purpose: a false yes here drops a real answer.
 */
export function isBareNone(text: string): boolean {
  if (ENGLISH_NONE.test(text)) return true;
  const read = parseAffirmation(text);
  if (read === null || read.value) return false;
  return (
    isBareYesNo(text) ||
    isBareYesNo(text.replace(NONE_QUANTIFIERS, " ")) ||
    isBareYesNo(withoutNoneWords(text))
  );
}
