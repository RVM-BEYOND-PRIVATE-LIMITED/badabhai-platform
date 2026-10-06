import { checkPersonaTokens } from "@badabhai/profiling-lexicon";
import { looksLikeOrgName, looksLikePii } from "@badabhai/validators";

/**
 * THE CAREER ANSWER'S DETERMINISTIC GATE (ADR-0046 P3 §2) — the API's half of "the model
 * writes what the worker reads". Every check below runs on the answer BEFORE a line is served,
 * and ANY failure serves the v1 fallback line instead (outcome `fallback`) — with ONE exception.
 *
 * THE ONE EXCEPTION (owner, 2026-10-03): a follow-up chip whose ONLY failure is its length (over
 * `CHIP_WORDS_MAX` words) is DROPPED and the answer is served without it. Every chip still runs
 * every CONTENT check first, whatever its length, and any content failure still rejects the whole
 * answer — so a dropped chip can never launder unsafe model text. A long LINE, too many chips and
 * every other failure still reject. `screenCareerAnswer` is the one entry point that applies it.
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
  | "format_char"
  | "control_char"
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
 *
 * TWO UNIT SYMBOLS ARE ALLOWED (TD147(3), 2026-10-05): `µ` (U+00B5 MICRO SIGN, written as the
 * Greek mu U+03BC too) and `Ω` (U+03A9, or the compatibility OHM SIGN U+2126). They are units a
 * trade answer legitimately uses ("0.02 µm", "4 Ω") — µ is `Common` but a letter, so the
 * letter arm barred it; Ω is Greek script, so the script arm did. They are stripped before the
 * test rather than patched into the regex, because a negated class cannot carry exceptions and
 * the four code points are exactly the ones a worker or model types for these units.
 */
const UNIT_SYMBOLS = /[\u00B5\u03BC\u2126\u03A9]/gu;
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
 * INVISIBLE FORMAT CHARACTERS (`\p{Cf}`) are barred outright: the zero-width space and non-joiner,
 * the word joiner, the soft hyphen, the BOM, the bidi controls. They are `Common` or `Inherited`
 * script, so `NON_LATIN` lets them through, and the fold below keeps them — so `Sal\u200Bary 25000`
 * walked past every word check while the worker read "Salary 25000", and a phone number split by
 * one walked past `looksLikePii`. A model writing Hinglish has no use for any of them. Checked
 * after `EMOJI` only so that the joiner and tag characters inside an emoji keep reporting as
 * `emoji`; both are rejections.
 */
const FORMAT_CHAR = /\p{Cf}/u;

/**
 * CONTROL CHARACTERS (`\p{Cc}` OTHER THAN `\t \n \r`) are barred for the same reason as
 * `FORMAT_CHAR`, and #1943 measured the hole they left. A C0/C1 control is `Common` script,
 * so `NON_LATIN` lets it through; the fold below keeps it; and `\s` does not match NEL
 * (`\u0085`), which a terminal renders as a line break. So `Tata Steel L\u0001td mein` and
 * `Tata Steel\u0085Ltd mein` read to a worker as the employer "Tata Steel Ltd" while the
 * `named_employer` heuristic sees no legal suffix — and the same split walks a phone number
 * past `looksLikePii`. The three allowed controls are layout only (a tab or a line break in a
 * multi-line answer); a model writing a Hinglish line needs no other. `\p{Cc}` also covers
 * DEL (`\u007F`) and the C1 block (`\u0080-\u009F`).
 */
const CONTROL_CHAR = /(?![\t\n\r])\p{Cc}/u;

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
 * MONEY (O10): a money WORD and a FIGURE in the same SENTENCE — "salary 25000", "15000 salary",
 * "₹ 20,000", "aapki salary shuru mein lagbhag 15000 hogi", "15k per month". The word alone is
 * advice ("salary apne employer se poochiye") and legal; a figure alone is a count ("2-3 years",
 * "8 hours") and legal.
 *
 * WHOLE WORDS. No LETTER may touch either end of a money word (`₹` is a sign and needs no
 * anchor): the old substring match failed "years", "hours", "course" and "workers" on `rs`,
 * "workplace" on `lac` and "hazard" on `hazar`, and every one of those is an ordinary career
 * answer. The anchors are letter lookarounds rather than `\b` because a digit is a word character
 * to `\b` — `Rs500`, `500rs` and `salary25000` must still fail.
 *
 * THE REACH IS THE SENTENCE, not a word count: a salary claim puts any number of words between
 * the word and the figure ("welder ki salary experience ke saath 25000 tak jaati hai"). Only a
 * sentence stop ends it — `.` `?` `!`, the danda, a newline — because text after a stop is what
 * the model could equally have written as its own line, and a line with a figure and no money
 * word is legal anyway. A COMMA DOES NOT END IT: "Salary, experience ke hisaab se, 15000 se 25000"
 * is exactly how a drifting model would phrase a wage, so "salary" and an unrelated count in one
 * comma-joined sentence fail too — the cost of that false positive is one fallback line. A `.`
 * between two digits is a decimal or grouping point (`1.5 lakh`), and the `rs.` abbreviation's
 * dot is part of the word (`Rs. 500`), so neither ends a sentence.
 *
 * TWO KINDS OF WORD. A CURRENCY word (₹, rs, rupaye, salary, tankhwah, lakh, hazaar and their
 * spellings) makes any figure money. A MONTH word (month(s), monthly, mahina, mahine) makes a
 * figure money only when it is WAGE-SIZED: four digits or more ("15000 mahina", "25000/month"),
 * or a figure with a thousands suffix ("15k per month", "15 thousand per month"). "6 mahine ka
 * course" and "har mahine 100 ghante" are a duration and a count, and no monthly wage is written
 * in three bare digits. (`hazaar` and `lakh` need no suffix rule: they are currency words.)
 *
 * BEYOND THE SPEC'S LIST (phase-3 §2 names the minimum, not the ceiling): `thousand`, `kamai`,
 * `income`, `wage(s)` and `stipend` are currency words too, and a THOUSANDS-SUFFIXED figure is money
 * on its own ("25k milte hain", "25 thousand milte hain") — in a career answer `15k` is a wage, and
 * without these a figure walked past with no listed word beside it. `paisa`/`paise` stay off the
 * list: "paise bachaiye" is ordinary advice and too often shares a sentence with a count.
 */
const CURRENCY_WORD =
  /₹|(?<!\p{L})(?:rs|rupaye|rupaya|rupay|rupees?|salary|salaries|tankhwah|tankha|lakhs?|lacs?|hazaar|hazar|thousands?|kamai|kamaai|kamaayi|income|wages?|stipend)(?!\p{L})/iu;
/** A figure with a thousands suffix (`15k`, `25 thousand`) — money with no word beside it. */
const THOUSANDS_FIGURE = /\p{Nd}\s*(?:k|thousand)(?!\p{L})/iu;
const MONTH_WORD = /(?<!\p{L})(?:months?|monthly|mahina|mahine|maheena|maheene)(?!\p{L})/iu;
/** Any figure at all. */
const FIGURE = /\p{Nd}/u;
/** A wage-sized figure: four digits or more (separators allowed: `8000`, `18,000`), or `15k`. */
const WAGE_FIGURE = /\p{Nd}(?:[.,]?\p{Nd}){3,}|\p{Nd}\s*(?:k|thousand)(?!\p{L})/iu;
/** The `rs.` abbreviation: its dot is rewritten to a space before the line is split. */
const RS_ABBREVIATION = /(?<!\p{L})(rs)\./giu;
/** A sentence stop — never a comma, and never a `.` between two digits. */
const SENTENCE_STOP = /[?!\u0964\u0965\n\r]|(?<!\p{Nd})\.|\.(?!\p{Nd})/u;

function statesMoney(scan: string): boolean {
  return scan
    .replace(RS_ABBREVIATION, "$1 ")
    .split(SENTENCE_STOP)
    .some(
      (sentence) =>
        THOUSANDS_FIGURE.test(sentence) ||
        (CURRENCY_WORD.test(sentence) && FIGURE.test(sentence)) ||
        (MONTH_WORD.test(sentence) && WAGE_FIGURE.test(sentence)),
    );
}

/**
 * PROMISES (O10): a guarantee about a job, however phrased. `zaroor milegi` is matched as a
 * phrase; `100%` is matched as the digit-percent pair.
 */
const PROMISE = /\b(?:pakka|pakki|guarantee|gaurantee)\b|zaroor milegi|100\s*%/i;

/**
 * SENSITIVE ADVICE (O10): legal, medical and financial terms. Whole-word, context-free matches
 * only — each listed word is enough on its own.
 *
 * NARROWED 2026-10-05 (TD147(2)). Three words were over-blocking ordinary Hinglish career
 * answers and are REMOVED, each with a must-pass test: `case` ("is case me" = "in this case"),
 * `policy` ("safety policy" is a first-aid subject), and `doctor` ("doctor ko dikhaiye" is
 * first-aid advice, not medical advice). Legal and medical questions are still refused by their
 * unambiguous words: court, vakil, wakil, lawyer, kanoon/kanun, dawai/dawa, ilaaj/ilaj. The
 * financial list (loan, emi, insurance, bima, invest, share market, sip, fd, rd) is unchanged.
 *
 * WHY WHOLE WORDS STILL MATTER: the previous substring forms (`case` inside "safety case",
 * `fd` inside "fd" only) are the same shape that made the money rule fail "years"/"hours"; `\b`
 * has held since the 2026-09-30 fix and is what keeps `rd` out of "card" / "hard".
 */
const SENSITIVE =
  /\b(?:court|vakil|wakil|lawyer|kanoon|kanun|dawai|dawa|ilaaj|ilaj|loan|emi|insurance|bima|invest|share market|sip|fd|rd)\b/i;

/**
 * RATING (O10): the worker compared or scored. `aap achhe`/`aap kamzor` phrasings, plus any
 * score/rank shape and the "7 out of 10" pattern.
 */
const RATING =
  /aap\s+(?:achhe|achha|acche|kamzor|weak|best|sabse)\b|\b(?:score|rank|rating)\b|\d+\s*(?:\/|out of|me se)\s*\d+/i;

const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

/** The worker-facing parts of a model answer — the fields `CompanionCareerAnswerSchema` parses. */
export interface CareerAnswerText {
  lines: readonly string[];
  followup_chips: readonly string[];
}

/**
 * The gate's decision: SERVE `answer` (the lines as written, the chips that survived the length
 * drop, `droppedChips` counting the rest) or REJECT the whole answer for `failure`.
 */
export type CareerScreenResult =
  | { kind: "serve"; answer: CareerAnswerText; droppedChips: number }
  | { kind: "reject"; failure: CareerAnswerFailure };

/** The one failure that DROPS a chip instead of rejecting the answer (owner, 2026-10-03). */
export const CHIP_DROP_REASON = "chip_too_long" satisfies CareerAnswerFailure;

/**
 * The checks on what a LINE or a CHIP SAYS — identical for both (the phase says the chips get "the
 * same checks", and they are served to the worker just like a line is). The word bound is NOT here:
 * the two artefacts answer it differently (a long line rejects, a long chip is dropped), and keeping
 * it out is what lets every chip run this whole list before any chip is dropped.
 */
function contentFailure(text: string): CareerAnswerFailure | null {
  if (text.trim().length === 0) return "empty_line";
  // µ and Ω are stripped for the script check only; every other check below reads the raw text.
  if (NON_LATIN.test(text.replace(UNIT_SYMBOLS, ""))) return "non_latin";
  const scan = scanForm(text);
  if (scan.includes("!")) return "exclamation";
  if (EMOJI.test(text)) return "emoji";
  if (FORMAT_CHAR.test(text)) return "format_char";
  if (CONTROL_CHAR.test(text)) return "control_char";
  if (checkPersonaTokens(scan).length > 0) return "persona";
  if (statesMoney(scan)) return "money";
  if (PROMISE.test(scan)) return "promise";
  if (SENSITIVE.test(scan)) return "sensitive_advice";
  if (RATING.test(scan)) return "worker_rating";
  if (looksLikeOrgName(scan)) return "named_employer";
  if (looksLikePii(scan)) return "pii";
  return null;
}

/** A line: over the word bound rejects; an empty line counts no words, so it reports `empty_line`. */
function lineFailure(line: string): CareerAnswerFailure | null {
  if (words(line) > LINE_WORDS_MAX) return "line_too_long";
  return contentFailure(line);
}

/** The answer's shape, on what the MODEL returned — extra chips are rejected, never trimmed. */
function shapeFailure(answer: CareerAnswerText): CareerAnswerFailure | null {
  if (answer.lines.length === 0) return "no_lines";
  if (answer.lines.length > LINES_MAX) return "too_many_lines";
  if (answer.followup_chips.length > CHIPS_MAX) return "too_many_chips";
  return null;
}

function firstFailure(
  texts: readonly string[],
  check: (text: string) => CareerAnswerFailure | null,
): CareerAnswerFailure | null {
  for (const text of texts) {
    const failure = check(text);
    if (failure !== null) return failure;
  }
  return null;
}

/** Counted on the folded form, so a fullwidth "？" spends the same budget as "?". */
function questionCount(texts: readonly string[]): number {
  return texts.reduce((n, text) => n + (scanForm(text).match(/\?/g) ?? []).length, 0);
}

const chipFits = (chip: string): boolean => words(chip) <= CHIP_WORDS_MAX;

/**
 * THE GATE THE CAREER TURN SERVES THROUGH: the answer through every check, in order, returning
 * either the answer to serve or the FIRST failure.
 *
 *   1. shape, on the model's answer (`too_many_chips` counts every chip the model wrote);
 *   2. every line — the word bound, then the content checks;
 *   3. EVERY chip through the content checks, the over-long ones included — a chip that fails any
 *      of them rejects the answer, whatever its length;
 *   4. only then the chips over `CHIP_WORDS_MAX` words are dropped (owner, 2026-10-03) — zero
 *      chips left is a valid answer (`followup_chips: []`);
 *   5. ≤ 1 "?" across the SERVED lines and chips: a dropped chip is never shown.
 *
 * ORDER IS REPORTING ORDER, NOT SECURITY ORDER — every check is a rejection, so the order only
 * decides which reason an operator sees when several apply.
 */
export function screenCareerAnswer(answer: CareerAnswerText): CareerScreenResult {
  const failure =
    shapeFailure(answer) ??
    firstFailure(answer.lines, lineFailure) ??
    firstFailure(answer.followup_chips, contentFailure);
  if (failure !== null) return { kind: "reject", failure };

  const served: CareerAnswerText = {
    lines: [...answer.lines],
    followup_chips: answer.followup_chips.filter(chipFits),
  };
  if (questionCount([...served.lines, ...served.followup_chips]) > QUESTIONS_MAX) {
    return { kind: "reject", failure: "too_many_questions" };
  }
  return {
    kind: "serve",
    answer: served,
    droppedChips: answer.followup_chips.length - served.followup_chips.length,
  };
}

/**
 * The answer AS WRITTEN: `null` only when it can be served VERBATIM, nothing dropped. A chip the
 * screen would drop reports `chip_too_long`, so a caller that serves the model's own arrays after a
 * `null` can never show an over-long chip. The career turn serves through `screenCareerAnswer`.
 */
export function validateCareerAnswer(answer: CareerAnswerText): CareerAnswerFailure | null {
  const screened = screenCareerAnswer(answer);
  if (screened.kind === "reject") return screened.failure;
  return screened.droppedChips > 0 ? CHIP_DROP_REASON : null;
}
