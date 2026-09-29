import { checkPersonaTokens } from "@badabhai/profiling-lexicon";
import { looksLikeOrgName, looksLikePii } from "@badabhai/validators";

/**
 * THE CAREER ANSWER'S DETERMINISTIC GATE (ADR-0046 P3 §2) — the API's half of "the model
 * writes what the worker reads". Every check below runs on the answer BEFORE a line is served,
 * and ANY failure serves the v1 fallback line instead (outcome `fallback`).
 *
 * WHY THIS IS NOT IN THE PROMPT. The prompt asks the model to obey all of this; the prompt is
 * not what enforces it. A model that drifts, a jailbreak, or a provider swap must not be able
 * to put a salary figure, a company name, a judgement of the worker or a Devanagari line in
 * front of a worker — and the only thing that can promise that is code the model does not
 * control. Same posture as the edit card's row validation.
 *
 * IT REUSES THE PLATFORM'S EXISTING DETECTORS rather than growing private copies:
 * `checkPersonaTokens` (packages/profiling-lexicon — the persona v3.2 scan, which already
 * carries the banned-vocative rule of ADR-0044 R8), `looksLikeOrgName` (the legal-entity
 * heuristic every jobs write path already rejects on, ADR-0024) and `looksLikePii`.
 *
 * THE FAILURE REASONS ARE A CLOSED SET and never contain a line of the answer: they reach a
 * log and an operator, and the answer is exactly what must not.
 */

/** Every way an answer can fail, as a closed vocabulary for logs and tests. */
export type CareerAnswerFailure =
  | "no_lines"
  | "too_many_lines"
  | "empty_line"
  | "line_too_long"
  | "devanagari"
  | "persona"
  | "exclamation"
  | "emoji"
  | "too_many_questions"
  | "money"
  | "promise"
  | "sensitive_advice"
  | "worker_rating"
  | "named_employer"
  | "pii"
  | "too_many_chips"
  | "chip_too_long";

const LINES_MAX = 4;
const LINE_WORDS_MAX = 20;
const CHIPS_MAX = 3;
const CHIP_WORDS_MAX = 4;
const QUESTIONS_MAX = 1;

/** Devanagari is barred outright (O9): the model writes Hinglish in Latin script only. */
const DEVANAGARI = /[\u0900-\u097F]/;
/** Pictographs and the emoji presentation selector — the persona ships no emoji. */
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|\u{FE0F}/u;

/**
 * MONEY (O10): a money word is only a failure when the SAME line carries a digit — the rule is
 * "digits next to a money word", so "salary apne employer se poochiye" (advice, no figure) is
 * legal while "salary 25000" is not. `mahina`/`mahine` are here because "25 hazaar per mahina"
 * is the commonest phrasing, and `lakh`/`hazaar` catch the Hindi numerals spelled in Latin.
 */
const MONEY_WORD =
  /(?:₹|rs\.?|rupaye|rupaya|salary|tankhwah|tankha|per month|mahina|mahine|lakh|lac|hazaar|hazar)/i;
const DIGIT = /\d/;

/**
 * PROMISES (O10): a guarantee about a job, however phrased. `zaroor milegi` is matched as a
 * phrase; `100%` is matched as the digit-percent pair.
 */
const PROMISE = /\b(?:pakka|pakki|guarantee|gaurantee)\b|zaroor milegi|100\s*%/i;

/**
 * SENSITIVE ADVICE (O10): legal, medical and financial terms. Deliberately broad — the cost of
 * a false positive is one fallback line, the cost of a false negative is the platform giving
 * advice it must not give.
 */
const SENSITIVE =
  /\b(?:court|case|vakil|wakil|lawyer|kanoon|kanun|dawai|dawa|ilaaj|ilaj|doctor|loan|emi|insurance|bima|policy|invest|share market|sip|fd|rd)\b/i;

/**
 * RATING (O10): the worker compared or scored. `aap achhe`/`aap kamzor` phrasings, plus any
 * score/rank shape and the "7 out of 10" pattern.
 */
const RATING =
  /aap\s+(?:achhe|achha|acche|kamzor|weak|best|sabse)\b|\b(?:score|rank|rating)\b|\d+\s*(?:\/|out of|me se)\s*\d+/i;

const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * The checks a LINE and a CHIP share. `maxWords` differs; everything else is identical — the
 * phase says the chips get "the same checks", and they are served to the worker just like a
 * line is.
 */
function contentFailure(text: string, maxWords: number): CareerAnswerFailure | null {
  if (text.trim().length === 0) return "empty_line";
  if (words(text) > maxWords) return "line_too_long";
  if (DEVANAGARI.test(text)) return "devanagari";
  if (text.includes("!")) return "exclamation";
  if (EMOJI.test(text)) return "emoji";
  if (checkPersonaTokens(text).length > 0) return "persona";
  if (DIGIT.test(text) && MONEY_WORD.test(text)) return "money";
  if (PROMISE.test(text)) return "promise";
  if (SENSITIVE.test(text)) return "sensitive_advice";
  if (RATING.test(text)) return "worker_rating";
  if (looksLikeOrgName(text)) return "named_employer";
  if (looksLikePii(text)) return "pii";
  return null;
}

/**
 * The answer through every check, in order, returning the FIRST failure or `null`.
 *
 * ORDER IS REPORTING ORDER, NOT SECURITY ORDER — every check is a rejection, so the order only
 * decides which reason an operator sees when several apply.
 */
export function validateCareerAnswer(answer: {
  lines: readonly string[];
  followup_chips: readonly string[];
}): CareerAnswerFailure | null {
  if (answer.lines.length === 0) return "no_lines";
  if (answer.lines.length > LINES_MAX) return "too_many_lines";
  if (answer.followup_chips.length > CHIPS_MAX) return "too_many_chips";

  for (const line of answer.lines) {
    const failure = contentFailure(line, LINE_WORDS_MAX);
    if (failure !== null) return failure;
  }
  for (const chip of answer.followup_chips) {
    const failure = contentFailure(chip, CHIP_WORDS_MAX);
    // A chip that fails the shared checks reports as its own reason where the bound differs,
    // so "chip_too_long" says which artefact broke rather than blaming a line.
    if (failure === "line_too_long") return "chip_too_long";
    if (failure !== null) return failure;
  }

  const questions = [...answer.lines, ...answer.followup_chips].reduce(
    (n, text) => n + (text.match(/\?/g) ?? []).length,
    0,
  );
  if (questions > QUESTIONS_MAX) return "too_many_questions";
  return null;
}
