/**
 * THE FREE CHAT'S REGIONAL WALLS (ADR-0051 §9, #2126) — the same guardrails the reply gate already
 * enforces in Hindi and English, in the five languages a free-chat reply may now be written in.
 *
 * WHY THEY EXIST. Owner ruling (2026-10-07): a worker who writes Marathi, Gujarati, Kannada, Telugu
 * or Tamil gets a reply in that language mixed with English, in LATIN letters — the way Hinglish
 * mixes Hindi and English — and every guardrail stays the same. The career gate's word walls
 * (persona, promise, sensitive advice, rating) are spelled in Hindi and English, so a Tamil
 * "will definitely get" or a Telugu "medicine" would walk past them. These lists close that gap
 * with each language's own words, so a regional reply is held to the same bar as a Hinglish one.
 *
 * LATIN ONLY, BY DESIGN. The career gate's `non_latin` wall stays on and rejects any reply in the
 * languages' own scripts, so every word here is a romanization. Spellings vary; each list carries
 * the common ones, and a miss costs nothing a prompt could not also miss — the reply prompts name
 * every word below (pinned by an ai-service parity test), so the model avoids them in the first
 * place, and this file is the deterministic backstop behind that.
 *
 * FREE CHAT ONLY. The companion's validator and its walls are untouched (ADR-0051 §4); these run
 * from `screenFreeChatAnswer` alone, over every line and chip — a chip the length rule would drop
 * is still model text. They apply to EVERY free-chat reply, a Hinglish one included; each word is
 * one no Hinglish reply should carry anyway.
 *
 * WHOLE WORDS AND WHOLE PHRASES on a folded form (NFKD, marks dropped, lowercased, every non-letter
 * a space), matched by set lookup and padded `includes` — no RegExp is built from these lists.
 *
 * THE FAILURE REASONS ARE THE CAREER GATE'S OWN (`persona`, `promise`, `sensitive_advice`,
 * `worker_rating`), so a log or an operator reads one vocabulary whatever the language.
 */

import type { CareerAnswerFailure } from "../../chat-companion/v2/career-output.validator";

/**
 * PERSONA (v3.2's spirit: never "bhai", "yaar", "beta"; always "aap"). Familiar address — brother,
 * buddy, son — and each language's informal "you". The respectful forms ("neenga", "meeru",
 * "neevu", "tumhi", "tame") are what the reply prompts ask for, and are not here.
 */
export const REGIONAL_PERSONA_TOKENS: readonly string[] = [
  // Tamil
  "anna",
  "thambi",
  "machan",
  "machi",
  "macha",
  "mapla",
  "dei",
  "nee",
  "unakku",
  "unnoda",
  // Telugu
  "tammudu",
  "tammi",
  "bava",
  "orey",
  "nuvvu",
  "neeku",
  "ninnu",
  // Kannada
  "maga",
  "machha",
  "neenu",
  "ninge",
  "ninna",
  // Marathi
  "bhau",
  "dada",
  "tula",
  "tujha",
  "tuzha",
  "tujhi",
  "tuzhi",
  "tujhya",
  "tuzhya",
  // Gujarati
  "tane",
  "taru",
  "tari",
  "taro",
];

/**
 * PROMISE — the career gate bans "pakka", "pakki", "guarantee", "zaroor milegi" and "100%". The
 * regional equivalent of "pakka" stands alone; the equivalent of "zaroor milegi" is a SURELY word
 * and a WILL-GET word in the same line ("kandippa kidaikkum", "nakki milel"), never either alone:
 * "kandippa try pannunga" is advice, as "zaroor try kijiye" is.
 */
export const REGIONAL_PROMISE_TOKENS: readonly string[] = ["pakku"];

/** The SURELY half of a regional "zaroor milegi". */
export const REGIONAL_SURELY_WORDS: readonly string[] = [
  // Tamil
  "kandippa",
  "kandipa",
  "nichayam",
  "nichayama",
  "nichayamaga",
  // Telugu
  "khachitanga",
  "kachitanga",
  "khachitamga",
  "tappakunda",
  // Kannada
  "khanditha",
  "khandita",
  "khanditavagi",
  "khandithavagi",
  "nischitavagi",
  // Marathi
  "nakki",
  "nakkich",
  "khatrine",
  // Gujarati
  "chokkas",
  "jaroor",
  "jarur",
];

/** The WILL-GET half of a regional "zaroor milegi". */
export const REGIONAL_WILL_GET_WORDS: readonly string[] = [
  // Tamil
  "kidaikkum",
  "kidaikum",
  "kedaikkum",
  "kedaikum",
  // Telugu
  "dorukutundi",
  "dorukuthundi",
  "vastundi",
  "vasthundi",
  // Kannada
  "sigutte",
  "siguthe",
  "sigatte",
  // Marathi
  "milel",
  "bhetel",
  // Gujarati
  "malse",
  "malshe",
];

/**
 * SENSITIVE ADVICE — legal, medical and financial words. The English ones (court, lawyer, loan,
 * insurance, invest, …) are already the career gate's and cover the English half of a mixed reply;
 * these are each language's own. Narrow by the same rule as the career list (TD147(2)): no word
 * that ordinary first-aid or safety advice needs ("upchar", as in "prathamik upchar", is left out).
 */
export const REGIONAL_SENSITIVE_WORDS: readonly string[] = [
  // Tamil — lawyer, court, medicine, treatment, loan, insurance, investment
  "vakkil",
  "vakeel",
  "neethimandram",
  "marundhu",
  "marunthu",
  "maruthuvam",
  "kadan",
  "kaapeedu",
  "kappeedu",
  "mudhaleedu",
  "mudaleedu",
  // Telugu — lawyer, medicine, treatment, loan, insurance, investment
  "nyayavadi",
  "mandu",
  "mandulu",
  "vaidyam",
  "appu",
  "runam",
  "beema",
  "pettubadi",
  // Kannada — lawyer, court, medicine, treatment, loan, insurance, investment
  "vakeelaru",
  "nyayalaya",
  "aushadhi",
  "oushadhi",
  "chikitse",
  "saala",
  "sala",
  "vime",
  "hoodike",
  // Marathi — court, medicine, loan, insurance, investment
  "nyayalay",
  "aushadh",
  "aushadhe",
  "karj",
  "karja",
  "vima",
  "guntavnuk",
  // Gujarati — court, medicine, treatment, insurance, investment
  "adalat",
  "dava",
  "davai",
  "sarvar",
  "vimo",
  "rokan",
];

/**
 * RATING — the career gate bans "aap achhe / achha / acche / kamzor / weak / best / sabse": the
 * respectful "you" directly followed by a judgement of the person. These are each language's
 * respectful "you" and its judgement words; any pronoun directly followed by any judgement word is
 * a rating ("neenga nalla", "tumhi best", "tame kamjor").
 */
export const REGIONAL_RESPECTFUL_YOU: readonly string[] = [
  "neenga",
  "meeru",
  "neevu",
  "tumhi",
  "tame",
];

/** The judgement half of a regional rating. */
export const REGIONAL_JUDGEMENT_WORDS: readonly string[] = [
  "best",
  "weak",
  // Tamil — good, excellent, bad
  "nalla",
  "sirandha",
  "mosam",
  // Telugu — good, great, bad
  "manchi",
  "goppa",
  "chetta",
  // Kannada — good, best, bad
  "olle",
  "shreshta",
  "ketta",
  // Marathi — good, bad, weak
  "chhan",
  "changle",
  "changla",
  "vait",
  "vaait",
  "kamjor",
  "kamzor",
  // Gujarati — good, bad
  "saara",
  "saru",
  "saaru",
  "kharab",
];

/** Lowercase, marks off, every non-letter or non-digit a space — the form every list reads. */
function foldWords(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const PERSONA = new Set(REGIONAL_PERSONA_TOKENS);
const PROMISE = new Set(REGIONAL_PROMISE_TOKENS);
const SURELY = new Set(REGIONAL_SURELY_WORDS);
const WILL_GET = new Set(REGIONAL_WILL_GET_WORDS);
const SENSITIVE = new Set(REGIONAL_SENSITIVE_WORDS);
const RESPECTFUL_YOU = new Set(REGIONAL_RESPECTFUL_YOU);
const JUDGEMENT = new Set(REGIONAL_JUDGEMENT_WORDS);

/** A regional "pakka", or a "surely" word and a "will get" word in one text. */
function promisesIn(words: readonly string[]): boolean {
  return (
    words.some((word) => PROMISE.has(word)) ||
    (words.some((word) => SURELY.has(word)) && words.some((word) => WILL_GET.has(word)))
  );
}

/**
 * The regional PROMISE wall ALONE — for a live-news tile's third-party headline (ADR-0054 §8),
 * which meets the promise wall but not the persona, sensitive or rating walls.
 */
export function regionalPromise(text: string): boolean {
  return promisesIn(foldWords(text).split(" ").filter(Boolean));
}

/** Does a respectful "you" sit directly before a judgement word? */
function ratesTheWorker(words: readonly string[]): boolean {
  return words.some((word, i) => {
    const next = words[i + 1];
    return RESPECTFUL_YOU.has(word) && next !== undefined && JUDGEMENT.has(next);
  });
}

/**
 * The first regional wall one line or chip fails, or `null`. Order mirrors the career gate's:
 * persona, promise, sensitive advice, rating.
 */
export function regionalWallFailure(text: string): CareerAnswerFailure | null {
  const words = foldWords(text).split(" ").filter(Boolean);
  if (words.some((word) => PERSONA.has(word))) return "persona";
  if (promisesIn(words)) return "promise";
  if (words.some((word) => SENSITIVE.has(word))) return "sensitive_advice";
  if (ratesTheWorker(words)) return "worker_rating";
  return null;
}
