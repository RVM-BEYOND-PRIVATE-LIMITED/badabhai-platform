import { checkPersonaTokens } from "@badabhai/profiling-lexicon";
import { looksLikeOrgName, looksLikePii } from "@badabhai/validators";

/**
 * THE CAREER ANSWER'S DETERMINISTIC GATE (ADR-0046 P3 §2) — the API's half of "the model
 * writes what the worker reads". Every check below runs on the answer BEFORE a line is served,
 * and ANY failure serves the v1 fallback line instead (outcome `fallback`).
 *
 * WHY THIS IS NOT IN THE PROMPT. The prompt asks the model to obey all of this; the prompt is
 * not what enforces it. A model that drifts, a jailbreak, or a provider swap must not be able
 * to put a salary figure, a company name, a judgement of the worker or a non-Latin line in
 * front of a worker — and the only thing that can promise that is code the model does not
 * control. Same posture as the edit card's row validation.
 *
 * IT REUSES THE PLATFORM'S EXISTING DETECTORS rather than growing private copies:
 * `checkPersonaTokens` (packages/profiling-lexicon — the persona v3.2 scan, which already
 * carries the banned-vocative rule of ADR-0044 R8), `looksLikeOrgName` (the legal-entity
 * heuristic every jobs write path already rejects on, ADR-0024) and `looksLikePii`.
 *
 * THE FAILURE REASONS ARE A CLOSED SET and never contain a line of the answer: they reach a
 * log and an operator, and the answer is exactly what must not. No event carries them — the
 * career event says only `fallback` — so the vocabulary can be renamed without a schema change.
 */

/** Every way an answer can fail, as a closed vocabulary for logs and tests. */
export type CareerAnswerFailure =
  | "no_lines"
  | "too_many_lines"
  | "empty_line"
  | "line_too_long"
  | "non_latin"
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

/**
 * LATIN SCRIPT ONLY (O9): the model writes Hinglish in Latin letters, so a character is barred
 * when ANY other script owns it — Devanagari, and equally Gurmukhi, Urdu (Arabic), Bengali, Tamil,
 * Cyrillic, Han: letters, vowel signs and native digits alike. Digits, punctuation, `₹` and the
 * typographic quotes are Unicode's `Common` script and stay legal; `Inherited` combining marks
 * stay legal so an accented Latin letter is not a failure.
 *
 * Two holes a script test alone leaves are closed by name: the mathematical alphabets (𝐒𝐚𝐥𝐚𝐫𝐲)
 * are LETTERS filed under `Common`, and the danda pair is `Common` punctuation only Indic text
 * uses — the old Devanagari-block rule barred both, and this one must not regress.
 *
 * WHY IT MATTERS BEYOND O9: every O10 pattern below is spelled in Latin, so a line in another
 * script would also walk past the money, promise, advice and rating checks.
 */
const NON_LATIN =
  /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]|(?!\p{Script=Latin})\p{L}|[\u0964\u0965]/u;

/**
 * EMOJI — the persona ships none. `Extended_Pictographic` is Unicode's own emoji-capable set
 * (⌛ ⭐ ⌚ 🀄 🅰 and every face and hand), so a new emoji release needs no range edit; regional
 * indicators are the halves of a flag (🇮🇳). The components that only ever BUILD an emoji —
 * skin-tone modifiers, variation selectors, the zero-width joiner, the keycap mark and the tag
 * characters — are barred on their own, so no sequence passes by dropping its pictograph. The
 * Misc Symbols and Dingbats blocks stay listed as before: ★ ☆ ✓ ✗ are not pictographic to
 * Unicode, and no Hinglish sentence needs them.
 */
const EMOJI =
  /\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\p{Variation_Selector}|\u{200D}|\u{20E3}|[\u{E0020}-\u{E007F}]|[\u{2600}-\u{27BF}]/u;

/**
 * THE FORM EVERY WORD PATTERN READS. The patterns below are spelled in plain ASCII, so a
 * lookalike would walk past them: fullwidth `Ｓａｌａｒｙ ２５０００` is Latin script and passes
 * `NON_LATIN`, and `sálary` is one accent away from the word list. NFKD maps the compatibility
 * forms to ASCII and splits an accent off its letter; dropping the marks leaves the plain word. A
 * clean ASCII line folds to itself, so the fold adds no false positive.
 *
 * `NON_LATIN` and `EMOJI` read the RAW text instead: the fold would turn 𝐒 into S and strip a
 * keycap's marks — exactly what those two checks exist to see.
 */
const scanForm = (text: string): string => text.normalize("NFKD").replace(/\p{M}/gu, "");

/**
 * MONEY (O10): a FIGURE next to a money WORD — "salary 25000", "15000 salary", "₹ 20,000",
 * "20 hazaar mahina". The word alone is advice ("salary apne employer se poochiye") and legal; a
 * figure alone is a count ("2-3 years", "8 hours") and legal.
 *
 * WHOLE WORDS. No LETTER may touch either end of a money word (`₹` is a sign and needs no
 * anchor): the old substring match failed "years", "hours", "course" and "workers" on `rs`,
 * "workplace" on `lac` and "hazard" on `hazar`, and every one of those is an ordinary career
 * answer. The anchors are letter lookarounds rather than `\b` because a digit is a word character
 * to `\b` — `Rs500`, `500rs` and `salary25000` must still fail.
 *
 * "NEXT TO" means the figure touches the word, or at most two words sit between them inside one
 * sentence ("salary lagbhag 20000", "mahine ka 18,000"). A sentence stop ends the reach, so a
 * line that says "salary" and later gives an unrelated count is not a salary figure.
 *
 * TWO KINDS OF WORD. A CURRENCY word (₹, rs, rupaye, salary, tankhwah, lakh, hazaar and their
 * spellings) makes any figure money. A MONTH word (per month, mahina, mahine) makes a figure money
 * only when it is salary-sized — four digits or more: "15000 mahina" is a wage, "6 mahine ka
 * course" and "har mahine 100 ghante" are a duration and a count, and no monthly wage is written
 * in three digits.
 */
const CURRENCY_WORD = String.raw`₹|(?<!\p{L})(?:rs|rupaye|rupaya|rupay|rupees?|salary|salaries|tankhwah|tankha|lakhs?|lacs?|hazaar|hazar)(?!\p{L})\.?`;
const MONTH_WORD = String.raw`(?<!\p{L})(?:per\s+month|mahina|mahine)(?!\p{L})`;
/** Any figure: `5`, `20,000`, `1.5`, `1,00,000` (a range like `15-20` is two figures). */
const FIGURE = String.raw`\p{Nd}(?:[.,]?\p{Nd})*`;
/** A salary-sized figure: four digits or more, separators allowed (`8000`, `18,000`). */
const WAGE_FIGURE = String.raw`\p{Nd}(?:[.,]?\p{Nd}){3,}`;
/** Spacing and joining punctuation, then at most two words — never a sentence stop. */
const MONEY_GAP = String.raw`[\s,:;()/~\u2013\u2014-]*(?:\p{L}+[\s,:;()/~\u2013\u2014-]+){0,2}`;

const moneyNear = (word: string, figure: string): RegExp =>
  new RegExp(`(?:${word})${MONEY_GAP}${figure}|${figure}${MONEY_GAP}(?:${word})`, "iu");
const MONEY = [moneyNear(CURRENCY_WORD, FIGURE), moneyNear(MONTH_WORD, WAGE_FIGURE)] as const;

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
  if (NON_LATIN.test(text)) return "non_latin";
  const scan = scanForm(text);
  if (scan.includes("!")) return "exclamation";
  if (EMOJI.test(text)) return "emoji";
  if (checkPersonaTokens(scan).length > 0) return "persona";
  if (MONEY.some((money) => money.test(scan))) return "money";
  if (PROMISE.test(scan)) return "promise";
  if (SENSITIVE.test(scan)) return "sensitive_advice";
  if (RATING.test(scan)) return "worker_rating";
  if (looksLikeOrgName(scan)) return "named_employer";
  if (looksLikePii(scan)) return "pii";
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

  // Counted on the folded form, so a fullwidth "？" spends the same budget as "?".
  const questions = [...answer.lines, ...answer.followup_chips].reduce(
    (n, text) => n + (scanForm(text).match(/\?/g) ?? []).length,
    0,
  );
  if (questions > QUESTIONS_MAX) return "too_many_questions";
  return null;
}
