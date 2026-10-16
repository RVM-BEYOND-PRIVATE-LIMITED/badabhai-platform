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
 * Is this ONLY a "no"? "nahi", "nahi ki", "nahin kiya", "koi nahi", "kuch nahi" — yes. Anything
 * carrying content ("ITI nahi, private se Tally kiya"), a "pata nahi" (a don't-know, which the
 * engine already declines), and a negated state ("main theek nahi hoon", #2250 — `isBareYesNo`
 * refuses it) — no. Strict on purpose: a false yes here drops a real answer.
 */
export function isBareNone(text: string): boolean {
  const read = parseAffirmation(text);
  if (read === null || read.value) return false;
  return isBareYesNo(text) || isBareYesNo(text.replace(NONE_QUANTIFIERS, " "));
}
