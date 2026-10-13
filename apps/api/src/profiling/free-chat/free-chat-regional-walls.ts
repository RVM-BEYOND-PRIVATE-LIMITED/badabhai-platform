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
 * a space), matched by set lookup and by comparing word sequences — no RegExp is built from these
 * lists.
 *
 * THE FAILURE REASONS ARE THE CAREER GATE'S OWN (`persona`, `promise`, `sensitive_advice`,
 * `worker_rating`), so a log or an operator reads one vocabulary whatever the language.
 *
 * AND ENGLISH (ADR-0051 §11, R40, #2181). English in, English out: a free-chat reply may now be
 * plain English, and the career gate's promise and rating walls are spelled for Hinglish ("pakka",
 * "zaroor milegi", "aap best"), so "You will definitely get a job after this course." and "You are
 * the best welder here." walked past them (owner rulings R11, R17). The English lists below close
 * that gap the way §9 closed it per language: "guaranteed" alone, or a "surely" word with a "will
 * get" phrase in one clause, is a promise, and the respectful "you" before a judgement word in one
 * clause is a rating. They are PHRASES, not single words, so they are matched on the folded word
 * sequence (see {@link phraseAt}), clause by clause (see {@link englishClauses}). The English
 * sensitive-advice words (owner ruling 2026-10-13, #2227) are single words, read like the regional
 * ones.
 *
 * AND THE SOFT JOB PROMISE (#2184). "Phir job mil jayegi" and "sthira kelasa milthade" carry no
 * "pakka" and no surely word, so every wall above served them. A job word followed by a future
 * "will get" form in one clause is a promise too, in Hinglish and in each §9 language (see
 * {@link SOFT_PROMISE_JOB_WORDS}). A question, or a listed take-back, disclaimer or condition
 * phrase unsays it, never a negation word alone; the "chance of getting a job" forms are other
 * words, so that advice stays served.
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
  // Kannada (milthade is how a model writes it: sthira kelasa milthade, #2184)
  "sigutte",
  "siguthe",
  "sigatte",
  "milthade",
  "miltade",
  // Marathi
  "milel",
  "bhetel",
  // Gujarati
  "malse",
  "malshe",
];

/**
 * SOFT JOB PROMISE (#2184) — a JOB WORD followed by a future "will get" form, in ONE CLAUSE: "phir
 * job mil jayegi", "aapko achha kaam mil jayega", "sthira kelasa milthade", "naukri milel". It needs
 * no surely word, because the future tense alone promises the job, and the "pakka" / "zaroor
 * milegi" walls never read it (R11).
 *
 * THE SHAPE IS NARROW ON PURPOSE. A walled reply is thrown away for the fallback line, so ambiguous
 * advice stays served:
 * - Only {@link SOFT_PROMISE_FILLERS} may sit between the two halves. "Kaam ki samajh mil jayegi"
 *   is about understanding the work, not getting a job.
 * - The will-get forms are future finite verbs. The "chance of getting a job" forms are different
 *   words: "kaam milne ki sambhavna badhegi", "job milne mein aasani hogi", "kaam milnyachi
 *   shakyata", "velai kidaikka vaaippu", "nokri malvani shakyata".
 * - A clause that asks is not a promise: one holding a question word ("kya aapko job mil jayegi,
 *   yeh company par nirbhar hai"), or the clause a "?" closes.
 * - Only a LISTED phrase unsays it, never a negation word alone ("Job mil jayegi, chinta mat
 *   kijiye" still promises): a take-back right after the form, read across a comma or semicolon
 *   ("job mil jayegi ya nahi, …", "Sirf certificate se job mil jayegi, aisa nahi hai") unless a
 *   "ki" opens a new statement after it; a disclaimer earlier in the clause, unless a "but" comes
 *   between ("Main yeh nahi keh sakta ki job mil jayegi"); or the job as a condition: "to" / "tab"
 *   after the form once "jab" / "agar" / "jo" opened it ("Jab job mil jayegi to offer letter
 *   zaroor lijiye"), or Tamil "bodhu" / "podhu". A bare "to" is "so": "Job mil jayegi to tension
 *   mat lijiye" promises.
 *
 * ACCEPTED LIMIT: a scam warning that quotes the promise across a comma ("Jo agent kehta hai ki
 * paise dene se naukri lag jayegi, woh fraud ho sakta hai") is walled. The prompts steer away
 * from the phrase, and the cost is one fallback line.
 */
export const SOFT_PROMISE_JOB_WORDS: readonly string[] = [
  // Hinglish, and the English word every mixed reply borrows
  "job",
  "naukri",
  "naukari",
  "kaam",
  // Marathi, Gujarati
  "nokri",
  // Tamil
  "velai",
  // Telugu
  "udyogam",
  // Kannada
  "kelasa",
  "kelsa",
  "udyoga",
];

/**
 * The Hinglish WILL-GET half: future forms of "mil" (get) and "lag" (land a job), with the common
 * "jaega" / "jaegi" spellings ("phir apne aap kaam mil jaega" was a real Haiku reply) and the "hi"
 * of certainty inside the verb. Not "lag jaega": "Is resume par thoda kaam lag jaega" means it will
 * take some effort. The regional half is {@link REGIONAL_WILL_GET_WORDS}, the regional promise
 * wall's own list.
 */
export const SOFT_PROMISE_WILL_GET_PHRASES: readonly string[] = [
  "mil jayegi",
  "mil jaayegi",
  "mil jaegi",
  "mil jayega",
  "mil jaayega",
  "mil jaega",
  "mil hi jayegi",
  "mil hi jayega",
  "mil hi jaegi",
  "mil hi jaega",
  "milegi hi",
  "lag jayegi",
  "lag jaayegi",
  "lag jaegi",
];

/**
 * The words or phrases that may sit between the job word and its will-get form ("job bhi mil
 * jayegi", "kaam to mil jayega", "job aasani se mil jayegi"). "se" is a filler only inside
 * "aasani se": "kaam se mil jayega" is not a job promise.
 */
export const SOFT_PROMISE_FILLERS: readonly string[] = [
  "bhi",
  "aapko",
  "jaldi",
  "turant",
  "zaroor",
  "zarur",
  "jaroor",
  "jarur",
  "hi",
  "to",
  "aasani se",
];

/**
 * A clause holding one of these asks rather than promises, wherever the word sits ("kya aapko job
 * mil jayegi", "job mil jayegi kya"). The profiling lexicon's `jobInterrogative` reads a worker's
 * "job milegi kya?" with "?", "kya", "kab" and a trailing "na"; this list adds "kahan" and "kaise",
 * and leaves "na" out: after a bot's promise it reassures ("job mil jayegi na"), it does not ask.
 */
export const SOFT_PROMISE_QUESTION_WORDS: readonly string[] = ["kya", "kab", "kahan", "kaise"];

/**
 * A TAKE-BACK right after the will-get form unsays the promise — in the same clause ("job mil jayegi
 * ya nahi, yeh skill par depend hai"), or opening the next one across a comma or semicolon ("Sirf
 * certificate se job mil jayegi, aisa nahi hai"). Nowhere else: "Aapko job mil jayegi aur salary
 * ki tension nahi rahegi" still promises. And not when {@link SOFT_PROMISE_NEW_STATEMENT} follows
 * it: "Job mil jayegi, zaroori nahi ki shuru mein salary zyada ho" promises the job and hedges the
 * salary.
 */
export const SOFT_PROMISE_TAKE_BACKS: readonly string[] = [
  // Hinglish
  "ya nahi",
  "ya nahin",
  "ki nahi",
  "aisa nahi",
  "yeh zaroori nahi",
  "zaroori nahi",
  // Marathi
  "asa nahi",
  // Gujarati
  "evu nathi",
  // Tamil, Kannada
  "nu illa",
  "nu illai",
];

/**
 * Right after a take-back, these open a NEW statement, so the take-back unsays that statement and
 * not the promise before it ("Aapko kaam mil jayega, aisa nahi hai ki aapko kuch nahi karna padega").
 */
export const SOFT_PROMISE_NEW_STATEMENT: readonly string[] = ["ki", "hai ki"];

/**
 * A DISCLAIMER earlier in the clause than the job word unsays the promise ("Main yeh nahi keh sakta
 * ki job mil jayegi", "Yeh mat sochiye ki sirf degree se job mil jayegi"). Each is a whole opening,
 * never a negation word alone: "Isme koi shak nahi ki aapko job mil jayegi" still promises. A
 * {@link SOFT_PROMISE_DISCLAIMER_BREAKS} word between it and the job word ends its reach.
 */
export const SOFT_PROMISE_DISCLAIMERS: readonly string[] = [
  "zaroori nahi ki",
  "nahi keh sakta ki",
  "nahi keh sakte ki",
  "nahi keh sakti ki",
  "nahi kar sakta ki",
  "aisa nahi hai ki",
  "mat sochiye ki",
  "mat samjhiye ki",
];

/**
 * Between a disclaimer and the job word, a "but" ends the disclaimer's reach and the promise
 * stands: "Main yeh nahi keh sakta ki kitna samay lagega par job mil jayegi". So does a new
 * subject after a "hai": "Yeh mat sochiye ki umar zyada hai aapko bhi job mil jayegi". "par" is
 * also "on", so "Zaroori nahi ki har site par job mil jayegi" is walled too; a fallback line is the
 * cheaper miss.
 */
export const SOFT_PROMISE_DISCLAIMER_BREAKS: readonly string[] = [
  "par",
  "lekin",
  "magar",
  "but",
  "phir bhi",
  "hai aapko",
];

/**
 * A CONDITION word right after the will-get form, in the same clause, makes the job the condition
 * rather than the promise: Tamil "Velai kidaikkum bodhu offer letter vaangunga".
 */
export const SOFT_PROMISE_CONDITIONS: readonly string[] = ["bodhu", "podhu"];

/**
 * An IF word earlier in the clause than the job word, with no THEN word between them, opens a
 * condition ("Jab naukri lag jayegi …", "Agar job mil jayegi …").
 */
export const SOFT_PROMISE_IF_WORDS: readonly string[] = ["jab", "agar", "jo"];

/**
 * A THEN word right after the will-get form closes an opened condition, in the same clause or
 * opening the next one across a comma or semicolon ("Jab naukri lag jayegi, tab aap ESI card
 * banwa sakte hain"). Without an IF word it is "so", and the job is the promised result: "Job mil
 * jayegi to tension mat lijiye", "Mehnat karoge to job mil jayegi to fir ghar ki tension khatam".
 * A THEN word before the job word cancels the IF word: "agar ITI karenge to job mil jayegi".
 */
export const SOFT_PROMISE_THEN_WORDS: readonly string[] = ["to", "tab"];

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

/**
 * ENGLISH PROMISE (§11) — the English "pakka" stands alone: "guaranteed" and "guarantees", which the
 * career gate's whole-word `guarantee` does not match ("A job is guaranteed after this course",
 * "This course guarantees a job", "Job guaranteed hai"), and "sure to get" after "is", "are" or
 * "you're" ("You are sure to get a job", "He is sure to get selected"), which carries its own
 * certainty. "Make sure to get your safety shoes" is advice and matches none of them.
 */
export const ENGLISH_PROMISE_TOKENS: readonly string[] = [
  "guaranteed",
  "guarantees",
  "is sure to get",
  "are sure to get",
  "you're sure to get",
];

/**
 * The English "zaroor milegi": a SURELY phrase and a WILL-GET phrase in ONE CLAUSE ("You will
 * definitely get a job", "Your salary will surely go up"). A surely phrase alone is advice ("You
 * can definitely try an ITI course"), as "kandippa try pannunga" is. The surely phrases are taken
 * out before the will-get phrase is looked for, so the adverb may sit inside it: "will definitely
 * get" reads as "will get". `100%` and "guarantee" are the career gate's already.
 */
export const ENGLISH_SURELY_WORDS: readonly string[] = [
  "definitely",
  "surely",
  "certainly",
  "for sure",
  "100 percent",
];

/**
 * The WILL-GET half of an English promise: a job, a hire, a selection or a raise. Not "will find":
 * "You will definitely find the form on the ITI site" is directions, not a promise. Not "sure to
 * get" either: its promise forms stand alone above, and here it walled "Definitely make sure to get
 * your certificate".
 */
export const ENGLISH_WILL_GET_WORDS: readonly string[] = [
  "will get",
  "will go up",
  "will be hired",
  "will be selected",
  "will increase",
  "will land",
];

/**
 * ENGLISH SENSITIVE ADVICE (§11; owner ruling 2026-10-13, #2227) — the medical, legal and money
 * words an English reply would advise with, whole words with their plurals, as each regional list
 * carries its language's own. The career gate's English list stops at the singular ("court",
 * "lawyer", "loan", "invest", …) and has no medical word an English reply uses ("Take a painkiller
 * tablet twice a day"). "doctor" stays OUT, as the career list keeps it out (TD147(2)): "please see
 * a doctor" is first-aid advice.
 */
export const ENGLISH_SENSITIVE_WORDS: readonly string[] = [
  // medical
  "tablet",
  "tablets",
  "painkiller",
  "painkillers",
  "medicine",
  "medicines",
  "dosage",
  "dose",
  "doses",
  "injection",
  "injections",
  // legal
  "lawyer",
  "lawyers",
  "court",
  // money
  "loan",
  "loans",
  "emi",
  "insurance",
  "invest",
  "investment",
  "investments",
];

/**
 * ENGLISH RATING (§11) — the English "aap best": the respectful "you" before a judgement word, in
 * ONE CLAUSE ("You are the best welder here", "You are not good at drawing"). Only the fillers below
 * may sit between them, so "You are learning fast" and "You are in a good trade" are served. A
 * conditional "if you are weak in drawing" is walled too; the prompts steer away from the shape,
 * and the cost of a miss is one fallback line.
 */
export const ENGLISH_RESPECTFUL_YOU: readonly string[] = ["you are", "you're"];

/** The words that may sit between the English "you" and the judgement word. */
export const ENGLISH_RATING_FILLERS: readonly string[] = [
  "the",
  "a",
  "an",
  "very",
  "really",
  "so",
  "not",
  "too",
  "quite",
];

/** The judgement half of an English rating: good and bad, as every regional list has them. */
export const ENGLISH_JUDGEMENT_WORDS: readonly string[] = [
  "best",
  "worst",
  "good",
  "bad",
  "poor",
  "weak",
  "perfect",
  "great",
  "excellent",
  "top",
  "number one",
];

/**
 * Where a clause ends for the English pair checks: the money wall's sentence stops (`?` `!` a
 * danda, a line break, a `.` not inside a number), plus a comma or semicolon not inside a number.
 * The fold erases punctuation, so without this "Please tell me where you are, the best ITI may be
 * near" read as a rating and "Definitely ask the supervisor, you will get a clear answer" as a
 * promise. The stop is CAPTURED, so a split keeps it: the soft job promise tells the clause a "?"
 * closes, and a take-back after a comma, from the rest.
 */
const CLAUSE_STOP = /([?!;\u0964\u0965\n\r]|(?<!\p{Nd})[.,]|[.,](?!\p{Nd}))/u;

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

/** A phrase as the folded words it matches ("you're" → ["you", "re"]). */
const phraseWords = (phrases: readonly string[]): readonly (readonly string[])[] =>
  phrases.map((phrase) => foldWords(phrase).split(" "));

const EN_PROMISE = phraseWords(ENGLISH_PROMISE_TOKENS);
const EN_SENSITIVE = new Set(ENGLISH_SENSITIVE_WORDS);
const EN_SURELY = phraseWords(ENGLISH_SURELY_WORDS);
const EN_WILL_GET = phraseWords(ENGLISH_WILL_GET_WORDS);
const EN_YOU = phraseWords(ENGLISH_RESPECTFUL_YOU);
const EN_FILLERS = new Set(ENGLISH_RATING_FILLERS);
const EN_JUDGEMENT = phraseWords(ENGLISH_JUDGEMENT_WORDS);

const JOB_WORDS = new Set(SOFT_PROMISE_JOB_WORDS);
const SOFT_WILL_GET = phraseWords([...SOFT_PROMISE_WILL_GET_PHRASES, ...REGIONAL_WILL_GET_WORDS]);
const SOFT_FILLERS = phraseWords(SOFT_PROMISE_FILLERS);
const SOFT_QUESTION = new Set(SOFT_PROMISE_QUESTION_WORDS);
const SOFT_TAKE_BACK = phraseWords(SOFT_PROMISE_TAKE_BACKS);
const SOFT_NEW_STATEMENT = phraseWords(SOFT_PROMISE_NEW_STATEMENT);
const SOFT_DISCLAIMER = phraseWords(SOFT_PROMISE_DISCLAIMERS);
const SOFT_DISCLAIMER_BREAK = phraseWords(SOFT_PROMISE_DISCLAIMER_BREAKS);
const SOFT_CONDITION = new Set(SOFT_PROMISE_CONDITIONS);
const SOFT_IF = new Set(SOFT_PROMISE_IF_WORDS);
const SOFT_THEN = new Set(SOFT_PROMISE_THEN_WORDS);
/** The stops a take-back is read across: a comma or a semicolon, never a sentence stop. */
const SOFT_STOPS = new Set([",", ";"]);

/** The length of the first of `phrases` that starts at `words[i]`, or 0. Whole words only. */
function phraseAt(
  words: readonly string[],
  i: number,
  phrases: readonly (readonly string[])[],
): number {
  for (const phrase of phrases) {
    if (phrase.every((word, k) => words[i + k] === word)) return phrase.length;
  }
  return 0;
}

/** Does any of `phrases` occur in `words`? */
function hasPhrase(words: readonly string[], phrases: readonly (readonly string[])[]): boolean {
  return words.some((_word, i) => phraseAt(words, i, phrases) > 0);
}

/** Is a clause nothing but surely phrases ("Definitely", "For sure")? */
function onlySurely(words: readonly string[]): boolean {
  for (let i = 0; i < words.length; ) {
    const size = phraseAt(words, i, EN_SURELY);
    if (size === 0) return false;
    i += size;
  }
  return true;
}

/** One clause of a line or chip: its folded words, and the stop that ends it ("" at the end). */
interface Clause {
  readonly words: readonly string[];
  readonly stop: string;
}

/** One line or chip as its clauses, split at {@link CLAUSE_STOP}, each with the stop it ends at. */
function clausesOf(text: string): Clause[] {
  const pieces = text.split(CLAUSE_STOP);
  const out: Clause[] = [];
  for (let i = 0; i < pieces.length; i += 2) {
    const words = foldWords(pieces[i] ?? "")
      .split(" ")
      .filter(Boolean);
    out.push({ words, stop: pieces[i + 1] ?? "" });
  }
  return out;
}

/**
 * The clauses' words for the English pair checks, empty clauses dropped. A clause that is ONLY a
 * surely phrase joins the next one (or the previous, at the end), so "Definitely, you will get a
 * job" and "You will get a job, for sure" still read as one promise.
 */
function englishClauses(parts: readonly Clause[]): string[][] {
  const out: string[][] = [];
  let carry: string[] = [];
  for (const { words } of parts) {
    if (words.length === 0) continue;
    if (onlySurely(words)) {
      carry = [...carry, ...words];
      continue;
    }
    out.push([...carry, ...words]);
    carry = [];
  }
  if (carry.length > 0) {
    const last = out.pop();
    out.push(last === undefined ? carry : [...last, ...carry]);
  }
  return out;
}

/**
 * An English "surely" phrase and a "will get" phrase in one clause. The contraction "you'll" folds
 * to "you ll", read as "will"; the surely phrases are dropped before the will-get phrase is looked
 * for.
 */
function englishPromise(words: readonly string[]): boolean {
  if (!hasPhrase(words, EN_SURELY)) return false;
  const rest: string[] = [];
  for (let i = 0; i < words.length; ) {
    const surely = phraseAt(words, i, EN_SURELY);
    if (surely > 0) {
      i += surely;
      continue;
    }
    rest.push(words[i] === "ll" ? "will" : (words[i] as string));
    i += 1;
  }
  return hasPhrase(rest, EN_WILL_GET);
}

/** Does the English respectful "you" sit before a judgement word, with only fillers between, in
 * one clause? */
function englishRating(words: readonly string[]): boolean {
  return words.some((_word, i) => {
    const you = phraseAt(words, i, EN_YOU);
    if (you === 0) return false;
    let j = i + you;
    while (j < words.length && EN_FILLERS.has(words[j] as string)) j += 1;
    return phraseAt(words, j, EN_JUDGEMENT) > 0;
  });
}

/** Does a take-back start at `words[at]` without opening a new statement ("aisa nahi hai ki …")? */
function takesBackAt(words: readonly string[], at: number): boolean {
  const size = phraseAt(words, at, SOFT_TAKE_BACK);
  return size > 0 && phraseAt(words, at + size, SOFT_NEW_STATEMENT) === 0;
}

/**
 * Is the will-get form that ends at `words[end]` of clause `k` unsaid right after it? A take-back,
 * or a THEN word closing an `opened` condition, in the same clause or, when the form ends the clause
 * at a comma or semicolon, opening the next one; or a standalone condition word in the same clause.
 */
function unsaidAfter(parts: readonly Clause[], k: number, end: number, opened: boolean): boolean {
  const { words, stop } = parts[k] as Clause;
  if (end < words.length) {
    const after = words[end] as string;
    return takesBackAt(words, end) || SOFT_CONDITION.has(after) || (opened && SOFT_THEN.has(after));
  }
  const next = parts[k + 1];
  if (!SOFT_STOPS.has(stop) || next === undefined) return false;
  return takesBackAt(next.words, 0) || (opened && SOFT_THEN.has(next.words[0] as string));
}

/** Does an IF word open a condition before the job word at `words[i]`, with no THEN word between? */
function opensCondition(words: readonly string[], i: number): boolean {
  for (let at = i - 1; at >= 0; at -= 1) {
    const word = words[at] as string;
    if (SOFT_THEN.has(word)) return false;
    if (SOFT_IF.has(word)) return true;
  }
  return false;
}

/** Is the job word at `words[i]` in a disclaimer's reach: one before it, with no break between? */
function disclaimed(words: readonly string[], i: number): boolean {
  return words.some((_word, at) => {
    const size = phraseAt(words, at, SOFT_DISCLAIMER);
    if (size === 0 || at + size > i) return false;
    return !hasPhrase(words.slice(at + size, i), SOFT_DISCLAIMER_BREAK);
  });
}

/**
 * Does a "?" close clause `k`: its own stop, or the stop of an empty clause right after it
 * ("Job mil jayegi...?", "Job mil jayegi!?")?
 */
function closedByQuestion(parts: readonly Clause[], k: number): boolean {
  for (let at = k; at < parts.length; at += 1) {
    const part = parts[at] as Clause;
    if (at > k && part.words.length > 0) return false;
    if (part.stop === "?") return true;
  }
  return false;
}

/** The index past the fillers ("bhi", "aasani se", …) that start at `words[start]`. */
function pastFillers(words: readonly string[], start: number): number {
  let at = start;
  let size = phraseAt(words, at, SOFT_FILLERS);
  while (size > 0) {
    at += size;
    size = phraseAt(words, at, SOFT_FILLERS);
  }
  return at;
}

/**
 * A soft job promise in clause `k`: a job word, then (past only the fillers) a will-get form. Not
 * when the clause asks (a question word anywhere in it, or a "?" closing it), when a disclaimer
 * reaches the job word, or when the form is taken back or made a condition right after.
 */
function softJobPromiseAt(parts: readonly Clause[], k: number): boolean {
  const { words } = parts[k] as Clause;
  if (closedByQuestion(parts, k) || words.some((word) => SOFT_QUESTION.has(word))) return false;
  return words.some((word, i) => {
    if (!JOB_WORDS.has(word)) return false;
    const j = pastFillers(words, i + 1);
    const form = phraseAt(words, j, SOFT_WILL_GET);
    if (form === 0 || disclaimed(words, i)) return false;
    return !unsaidAfter(parts, k, j + form, opensCondition(words, i));
  });
}

/** A soft job promise in any clause of one line or chip. */
function softJobPromise(parts: readonly Clause[]): boolean {
  return parts.some((_part, k) => softJobPromiseAt(parts, k));
}

/** A regional "pakka", or a "surely" word and a "will get" word in one text. */
function promisesIn(words: readonly string[]): boolean {
  return (
    words.some((word) => PROMISE.has(word)) ||
    (words.some((word) => SURELY.has(word)) && words.some((word) => WILL_GET.has(word)))
  );
}

/**
 * The regional PROMISE wall ALONE — for a live-news tile's third-party headline (ADR-0054 §8),
 * which meets the promise wall but not the persona, sensitive or rating walls. The English promise
 * walls (§11) are NOT applied to headlines: "Fuel prices will surely go up" and "State guarantees
 * minimum wage" are news someone else wrote, not promises the app makes. Nor is the soft job
 * promise (#2184), for the same reason: "Yuvaon ko naukri mil jayegi: mantri" reports a claim.
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
 * The first regional or English wall one line or chip fails, or `null`. Order mirrors the career
 * gate's: persona, promise, sensitive advice, rating.
 */
export function regionalWallFailure(text: string): CareerAnswerFailure | null {
  const words = foldWords(text).split(" ").filter(Boolean);
  const parts = clausesOf(text);
  const clauses = englishClauses(parts);
  if (words.some((word) => PERSONA.has(word))) return "persona";
  if (
    promisesIn(words) ||
    hasPhrase(words, EN_PROMISE) ||
    clauses.some(englishPromise) ||
    softJobPromise(parts)
  ) {
    return "promise";
  }
  if (words.some((word) => SENSITIVE.has(word) || EN_SENSITIVE.has(word))) {
    return "sensitive_advice";
  }
  if (ratesTheWorker(words) || clauses.some(englishRating)) return "worker_rating";
  return null;
}
