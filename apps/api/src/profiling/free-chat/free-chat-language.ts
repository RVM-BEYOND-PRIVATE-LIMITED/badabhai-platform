/**
 * THE FREE CHAT'S REPLY LANGUAGE (ADR-0051 §11, owner rulings R39–R41) — PURE: text in, a closed
 * `FreeChatReplyLanguage` out. No I/O, no model.
 *
 * CODE DECIDES, THE MODEL FOLLOWS (R39). On the production model the reply prompt's own "answer in
 * the worker's language" rule did not hold (9 of 10 regional questions came back in Hinglish), so
 * the language is decided here, deterministically, and handed to the reply and news calls as
 * `reply_language`.
 *
 * THREE READERS:
 *   - {@link detectReplyLanguage} — the language a message is WRITTEN in (R40). A Gujarati, Tamil,
 *     Telugu or Kannada script decides that language; Devanagari is Marathi when Marathi markers
 *     outweigh Hindi ones, else Hinglish; Latin text is scored against per-language marker words.
 *     A tie, or too little evidence, is Hinglish.
 *   - {@link parseLanguageRequest} — an EXPLICIT request to reply in a language (R41): "marathi mai
 *     jawab do", "reply in Tamil", "telugu lo cheppandi" — and whether it is BARE (nothing else in
 *     the message), the only kind that skips the classifier. A message that merely MENTIONS a
 *     language ("main marathi hoon", "tamil me kaam karna hai") is not one.
 *   - {@link readTypedLanguageAnswer} — a typed yes / no to the pending ask, and nothing more.
 *
 * THE WORD LISTS live in `free-chat-language.lexicon.ts` (closed, fabricated, data only). A miss
 * costs a Hinglish reply, which is what the chat served before this ruling.
 *
 * NO RUNTIME IMPORTS beyond that data module: the closed set is imported as a type, so this module
 * stays readable by anything that boots nothing.
 */

import type { FreeChatReplyLanguage } from "@badabhai/types";

import {
  ANSWER_HONORIFIC_WORDS,
  BOL_WORDS,
  DIRECT_VERB_WORDS,
  ENGLISH_DIRECT_VERB_WORDS,
  ENGLISH_IN_WORDS,
  ENGLISH_LATIN_WORDS,
  ENGLISH_REQUEST_VERB_WORDS,
  GENERIC_VERB_WORDS,
  GLUED_LOCATIVES,
  HINDI_DEVANAGARI_WORDS,
  HINDI_LATIN_WORDS,
  HINDI_SHARED_WORDS,
  LANGUAGE_NAMES,
  LANGUAGE_NO_WORDS,
  LANGUAGE_YES_PHRASES,
  LANGUAGE_YES_WORDS,
  LOCATIVE_WORDS,
  MARATHI_DEVANAGARI_WORDS,
  MODAL_WORDS,
  NEGATION_WORDS,
  PLACE_SUFFIX_WORDS,
  PLEASE_WORDS,
  POST_VERB_NEGATION_WORDS,
  REGIONAL_LATIN_WORDS,
  REPLY_NOUN_WORDS,
  REQUEST_FILLER_WORDS,
  SPEECH_VERB_WORDS,
  TRAILING_WORDS,
  type RegionalLanguage,
} from "./free-chat-language.lexicon";

// ---------------------------------------------------------------------------
// Tokenizing — letters and their marks kept, so an Indic word survives whole
// ---------------------------------------------------------------------------

/**
 * One token, normalized: NFC (so a precomposed nukta letter and its decomposed spelling are one
 * word), lowercased, the zero-width non-joiner and joiner (U+200C, U+200D) dropped — Indic
 * keyboards insert them inside a word, and they are not separators.
 */
function normalizeToken(token: string): string {
  return token
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\u200c\u200d]/g, "");
}

/**
 * A message as tokens: apostrophes dropped ("don't" is "dont"), every run of anything that is not
 * a letter, a combining mark or a digit a separator. UNLIKE the chip fold in `free-chat.router.ts`,
 * the combining marks are KEPT: a Devanagari or Dravidian vowel sign is part of the word, and
 * stripping it would make "मराठी" read as "मरठ".
 */
export function languageTokens(text: string): string[] {
  const folded = normalizeToken(text)
    .replace(/['`\u2018\u2019\u02bc]/g, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
  return folded.length === 0 ? [] : folded.split(" ");
}

/** A closed word list as a set of normalized tokens. */
function wordSet(...lists: ReadonlyArray<readonly string[]>): ReadonlySet<string> {
  return new Set(lists.flat().map(normalizeToken));
}

/** Any token of `set` in `tokens[from, to)`. */
function anyIn(tokens: readonly string[], set: ReadonlySet<string>, from: number, to: number) {
  return tokens.slice(Math.max(0, from), Math.max(0, to)).some((token) => set.has(token));
}

/** The first index in `[from, to)` whose token is in `set`, or -1. */
function findFirst(tokens: readonly string[], set: ReadonlySet<string>, from: number, to: number) {
  for (let j = Math.max(0, from); j < Math.min(to, tokens.length); j++) {
    if (set.has(tokens[j]!)) return j;
  }
  return -1;
}

/** The last index in `[from, to)` whose token is in `set`, or -1. */
function findLast(tokens: readonly string[], set: ReadonlySet<string>, from: number, to: number) {
  for (let j = to - 1; j >= Math.max(0, from); j--) if (set.has(tokens[j]!)) return j;
  return -1;
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

/**
 * The Indic scripts the detector reads: Devanagari (Hindi or Marathi), and the four scripts that
 * each belong to one language — so a regional script's name IS its language.
 */
type Script = "devanagari" | Exclude<RegionalLanguage, "marathi">;

/** The Unicode blocks the detector reads, inclusive. */
const SCRIPT_BLOCKS: ReadonlyArray<readonly [lo: number, hi: number, script: Script]> = [
  [0x0900, 0x097f, "devanagari"],
  [0x0a80, 0x0aff, "gujarati"],
  [0x0b80, 0x0bff, "tamil"],
  [0x0c00, 0x0c7f, "telugu"],
  [0x0c80, 0x0cff, "kannada"],
];

/**
 * Devanagari characters that belong to no language: the danda and double danda (U+0964, U+0965 —
 * every Indic script and many English keyboards use them as a full stop) and the Devanagari digits
 * (U+0966-U+096F). "I want a job in Pune।" is English.
 */
const SCRIPT_NEUTRAL_LO = 0x0964;
const SCRIPT_NEUTRAL_HI = 0x096f;

/** How many letters of each Indic script the text carries. */
function scriptCounts(text: string): Map<Script, number> {
  const counts = new Map<Script, number>();
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= SCRIPT_NEUTRAL_LO && code <= SCRIPT_NEUTRAL_HI) continue;
    const block = SCRIPT_BLOCKS.find(([lo, hi]) => code >= lo && code <= hi);
    if (block !== undefined) counts.set(block[2], (counts.get(block[2]) ?? 0) + 1);
  }
  return counts;
}

/**
 * The script that decides, or null for a Latin-only (or script-less) message. A Gujarati, Tamil,
 * Telugu or Kannada script decides its language as long as it carries at least as many characters
 * as Devanagari. Two regional scripts tied at the top decide nothing (Hinglish).
 */
function decidingScript(text: string): Script | "tie" | null {
  const counts = scriptCounts(text);
  if (counts.size === 0) return null;
  let top: Script | null = null;
  let best = 0;
  let tied = false;
  for (const [script, n] of counts) {
    if (script === "devanagari") continue;
    if (n > best) {
      top = script;
      best = n;
      tied = false;
    } else if (n === best) {
      tied = true;
    }
  }
  if (top !== null && best >= (counts.get("devanagari") ?? 0)) return tied ? "tie" : top;
  return "devanagari";
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const MARATHI_DEVANAGARI = wordSet(MARATHI_DEVANAGARI_WORDS);
const HINDI_DEVANAGARI = wordSet(HINDI_DEVANAGARI_WORDS);
const HINDI_LATIN = wordSet(HINDI_LATIN_WORDS);
const ENGLISH_LATIN = wordSet(ENGLISH_LATIN_WORDS);
const REGIONAL_LANGUAGES = Object.keys(REGIONAL_LATIN_WORDS) as RegionalLanguage[];
const REGIONAL_LATIN: Readonly<Record<RegionalLanguage, ReadonlySet<string>>> = {
  marathi: wordSet(REGIONAL_LATIN_WORDS.marathi),
  gujarati: wordSet(REGIONAL_LATIN_WORDS.gujarati),
  tamil: wordSet(REGIONAL_LATIN_WORDS.tamil),
  telugu: wordSet(REGIONAL_LATIN_WORDS.telugu),
  kannada: wordSet(REGIONAL_LATIN_WORDS.kannada),
};

/** The language(s) Hindi shares each shared word with — see `HINDI_SHARED_WORDS`. */
type SharedWith = keyof typeof HINDI_SHARED_WORDS;
const HINDI_SHARED: ReadonlyMap<string, ReadonlySet<SharedWith>> = (() => {
  const index = new Map<string, Set<SharedWith>>();
  for (const [language, words] of Object.entries(HINDI_SHARED_WORDS) as Array<
    [SharedWith, readonly string[]]
  >) {
    for (const word of words.map(normalizeToken)) {
      index.set(word, (index.get(word) ?? new Set<SharedWith>()).add(language));
    }
  }
  return index;
})();

/** Fewer Latin words than this is too little evidence: "ok", "hello", an emoji — Hinglish. */
const MIN_EVIDENCE_WORDS = 2;
/** English needs at least this many function words… */
const MIN_ENGLISH_WORDS = 2;
/** …and they must be at least this share of the message's words ("mostly English"). */
const MIN_ENGLISH_SHARE = 1 / 3;
/** A regional language with this many DISTINCT markers decides on them alone. */
const STRONG_REGIONAL_MARKERS = 2;

/** How many DISTINCT words of `words` are in `set` — "aste aste" is one marker, not two. */
function distinctIn(words: readonly string[], set: ReadonlySet<string>): number {
  return new Set(words.filter((word) => set.has(word))).size;
}

/** How many of `words` are in `set`. */
function score(words: readonly string[], set: ReadonlySet<string>): number {
  return words.reduce((n, word) => n + (set.has(word) ? 1 : 0), 0);
}

/**
 * Does the message carry a word Hindi shares with a language OTHER than `language`? Then it is
 * Hindi-shaped, and one marker of `language` is not enough ("aste aste kaam karo": "karo" is Hindi
 * and Gujarati, so the lone Marathi "aste" does not decide).
 */
function hindiShapedFor(words: readonly string[], language: RegionalLanguage): boolean {
  return words.some((word) => {
    const sharedWith = HINDI_SHARED.get(word);
    return sharedWith !== undefined && !sharedWith.has(language);
  });
}

/** Devanagari: Marathi when its distinct markers outweigh Hindi's; a tie or nothing is Hinglish. */
function devanagariLanguage(tokens: readonly string[]): FreeChatReplyLanguage {
  return distinctIn(tokens, MARATHI_DEVANAGARI) > distinctIn(tokens, HINDI_DEVANAGARI)
    ? "marathi"
    : "hinglish";
}

/** The regional language with the most distinct markers, alone at the top — or null. */
function topRegional(
  words: readonly string[],
): { readonly language: RegionalLanguage; readonly markers: number } | null {
  let top: RegionalLanguage | null = null;
  let best = 0;
  let tied = false;
  for (const language of REGIONAL_LANGUAGES) {
    const n = distinctIn(words, REGIONAL_LATIN[language]);
    if (n > best) {
      top = language;
      best = n;
      tied = false;
    } else if (n === best && n > 0) {
      tied = true;
    }
  }
  return top === null || tied ? null : { language: top, markers: best };
}

/**
 * Latin letters, in this order:
 *   1. too few words → Hinglish;
 *   2. the regional language with the most DISTINCT markers wins if it is the ONLY one at the top
 *      and beats Hindi's distinct count, AND either carries two distinct markers, or carries one
 *      that is at least as strong as the English evidence in a message that is not Hindi-shaped
 *      (no word Hindi shares with another language — "main vela baitha hu" is not Tamil on "vela",
 *      "aste aste kaam karo" is not Marathi on "aste");
 *   3. any Hindi marker → Hinglish;
 *   4. mostly English function words → English;
 *   5. anything else → Hinglish (unsure).
 */
function latinLanguage(tokens: readonly string[]): FreeChatReplyLanguage {
  const words = tokens.filter((token) => /^[a-z]+$/.test(token));
  if (words.length < MIN_EVIDENCE_WORDS) return "hinglish";
  const hindi = distinctIn(words, HINDI_LATIN);
  const english = score(words, ENGLISH_LATIN);

  const top = topRegional(words);
  if (top !== null && top.markers > hindi) {
    if (top.markers >= STRONG_REGIONAL_MARKERS) return top.language;
    if (top.markers >= english && !hindiShapedFor(words, top.language)) return top.language;
  }
  if (hindi > 0) return "hinglish";
  if (english >= MIN_ENGLISH_WORDS && english >= words.length * MIN_ENGLISH_SHARE) return "english";
  return "hinglish";
}

/**
 * THE LANGUAGE ONE MESSAGE IS WRITTEN IN (R40) — the reply's language when the worker keeps none.
 * Never throws; anything it cannot read is Hinglish, the chat's language before this ruling.
 */
export function detectReplyLanguage(text: string): FreeChatReplyLanguage {
  const script = decidingScript(text);
  if (script === "tie") return "hinglish";
  if (script === "devanagari") return devanagariLanguage(languageTokens(text));
  if (script !== null) return script;
  return latinLanguage(languageTokens(text));
}

// ---------------------------------------------------------------------------
// An explicit request: "marathi mai jawab do", "reply in Tamil" (R41)
// ---------------------------------------------------------------------------

/** What one name token says: the language, and whether "in" is glued onto it. */
interface NamedLanguage {
  readonly language: FreeChatReplyLanguage;
  readonly glued: boolean;
}

/** One list's tokens, each pointing at its language. */
function nameEntries(
  lists: Readonly<Record<FreeChatReplyLanguage, readonly string[]>>,
  glued: boolean,
): Array<[string, NamedLanguage]> {
  return (Object.entries(lists) as Array<[FreeChatReplyLanguage, readonly string[]]>).flatMap(
    ([language, names]) =>
      names.map((name): [string, NamedLanguage] => [normalizeToken(name), { language, glued }]),
  );
}

/** Token → the language it names (bare or with "in" glued on). */
const NAME_INDEX: ReadonlyMap<string, NamedLanguage> = new Map([
  ...nameEntries(LANGUAGE_NAMES, false),
  ...nameEntries(GLUED_LOCATIVES, true),
]);

/** The language a token names (bare or with "in" glued on), or null. */
export function languageNamed(token: string): FreeChatReplyLanguage | null {
  return NAME_INDEX.get(normalizeToken(token))?.language ?? null;
}

const LOCATIVES = wordSet(LOCATIVE_WORDS);
const SPEECH_VERBS = wordSet(SPEECH_VERB_WORDS);
const GENERIC_VERBS = wordSet(GENERIC_VERB_WORDS);
const REPLY_NOUNS = wordSet(REPLY_NOUN_WORDS);
/** What completes "jawab …" / "baat …": a generic verb ("do", "karo") or a modal ("kar sakte"). */
const NOUN_COMPLETIONS = wordSet(GENERIC_VERB_WORDS, MODAL_WORDS);
const BOL = wordSet(BOL_WORDS);
const MODALS = wordSet(MODAL_WORDS);
const DIRECT_VERBS = wordSet(DIRECT_VERB_WORDS);
const ENGLISH_REQUEST_VERBS = wordSet(ENGLISH_REQUEST_VERB_WORDS);
const ENGLISH_DIRECT_VERBS = wordSet(ENGLISH_DIRECT_VERB_WORDS);
const ENGLISH_IN = wordSet(ENGLISH_IN_WORDS);
const PLEASE = wordSet(PLEASE_WORDS);
const NEGATIONS = wordSet(NEGATION_WORDS);
const POST_VERB_NEGATIONS = wordSet(POST_VERB_NEGATION_WORDS);
const PLACE_SUFFIXES = wordSet(PLACE_SUFFIX_WORDS);
const TRAILING = wordSet(TRAILING_WORDS, REPLY_NOUN_WORDS);

/**
 * THE REQUEST GRAMMAR, minus the names (read off {@link NAME_INDEX}): every word a BARE request may
 * be made of. Closed: the lexicon's lists, and nothing a worker's own words could add.
 */
const REQUEST_GRAMMAR = wordSet(
  LOCATIVE_WORDS,
  SPEECH_VERB_WORDS,
  GENERIC_VERB_WORDS,
  REPLY_NOUN_WORDS,
  BOL_WORDS,
  MODAL_WORDS,
  DIRECT_VERB_WORDS,
  ENGLISH_REQUEST_VERB_WORDS,
  ENGLISH_IN_WORDS,
  PLEASE_WORDS,
  NEGATION_WORDS,
  REQUEST_FILLER_WORDS,
);

/** A request is a short message; a long one that names a language is talking ABOUT it. */
const REQUEST_MAX_TOKENS = 12;
/** How far a request's verb may sit from the name. */
const REQUEST_WINDOW = 4;

/** "english mein bolo MAT" — the prohibitive straight after the verb at `verbAt`. */
function prohibitedAfter(tokens: readonly string[], verbAt: number): boolean {
  const after = tokens[verbAt + 1];
  return after !== undefined && POST_VERB_NEGATIONS.has(after);
}

/**
 * The index of the word that AIMS a locative request at the reply, in `[from, from + window)`, or
 * -1: a speech verb ("bolo", "sollunga"), "bol" + a modal ("bol sakte"), or a reply noun followed
 * by a generic verb or a modal ("jawab do", "baat karo", "baat kar sakte").
 */
function aimedAt(tokens: readonly string[], from: number): number {
  const to = Math.min(from + REQUEST_WINDOW, tokens.length);
  for (let j = from; j < to; j++) {
    const token = tokens[j]!;
    if (SPEECH_VERBS.has(token)) return j;
    if (BOL.has(token) && MODALS.has(tokens[j + 1] ?? "")) return j + 1;
    if (REPLY_NOUNS.has(token)) {
      const verb = findFirst(tokens, NOUN_COMPLETIONS, j + 1, j + 1 + REQUEST_WINDOW);
      if (verb >= 0) return verb;
    }
  }
  return -1;
}

/**
 * "{L} mein …" (or a glued "marathit …"), the name at `i` and the words after "in" from `from`:
 *   - AIMED: a speech verb or a reply noun + verb within the window ("jawab do", "bolo");
 *   - NOTHING CONTENTFUL AFTER IT: "marathi mein", "jawab marathi mein", "marathi mein please";
 *   - a GENERIC verb ("batao", "karo"), only when the whole message is the request (`bare`):
 *     "kannada me batao" asks, "gujarati mein job batao" does not.
 * A negation between the name and its verb ("mat bolo", "nahi") cancels it — and only that one: a
 * negation after the request ("english mein bolo, hindi nahi aati") is another clause.
 */
function locativeRequest(
  tokens: readonly string[],
  i: number,
  from: number,
  bare: boolean,
): boolean {
  const negatedUpTo = (verbAt: number) =>
    anyIn(tokens, NEGATIONS, i + 1, verbAt + 1) || prohibitedAfter(tokens, verbAt);
  const aimed = aimedAt(tokens, from);
  if (aimed >= 0) return !negatedUpTo(aimed);
  if (tokens.slice(from).every((token) => TRAILING.has(token))) return true;
  if (!bare) return false;
  const generic = findFirst(tokens, GENERIC_VERBS, from, from + REQUEST_WINDOW);
  return generic >= 0 && !negatedUpTo(generic);
}

/**
 * "[verb] in {L}" / "speak {L}" / "in {L} please" — the English shapes, the verb BEFORE the name
 * and never negated in the two words before it ("dont reply in English").
 */
function englishRequest(tokens: readonly string[], i: number): boolean {
  const prev = tokens[i - 1];
  if (prev === undefined) return false;
  const verbAt = ENGLISH_DIRECT_VERBS.has(prev)
    ? i - 1
    : ENGLISH_IN.has(prev)
      ? findLast(tokens, ENGLISH_REQUEST_VERBS, i - 1 - REQUEST_WINDOW, i - 1)
      : -1;
  if (verbAt >= 0) return !anyIn(tokens, NEGATIONS, verbAt - 2, verbAt);
  // "in Tamil please", "please, in Tamil" — a short ask with nothing else in it.
  return (
    ENGLISH_IN.has(prev) && tokens.length <= REQUEST_WINDOW && tokens.some((t) => PLEASE.has(t))
  );
}

/**
 * Is the language named at `i` the object of a request? Its three shapes: LOCATIVE ("{L} mein
 * bolo", {@link locativeRequest}); DIRECT ("{L} bolo", "{L} bol sakte ho", "{L} please"); ENGLISH
 * ({@link englishRequest}). A name followed by "nadu" is a place, not a language.
 */
function requestsAt(tokens: readonly string[], i: number, glued: boolean, bare: boolean) {
  const next = tokens[i + 1];
  if (next !== undefined && PLACE_SUFFIXES.has(next)) return false;
  const afterLocative = glued ? i + 1 : next !== undefined && LOCATIVES.has(next) ? i + 2 : null;
  if (afterLocative !== null) return locativeRequest(tokens, i, afterLocative, bare);
  if (next !== undefined && (DIRECT_VERBS.has(next) || PLEASE.has(next))) {
    return !prohibitedAfter(tokens, i + 1);
  }
  if (next !== undefined && BOL.has(next) && MODALS.has(tokens[i + 2] ?? "")) return true;
  return englishRequest(tokens, i);
}

/** An explicit request to reply in a language (R41). */
export interface LanguageRequest {
  readonly language: FreeChatReplyLanguage;
  /**
   * EVERY word of the message belongs to the request grammar (a language's name, an "in"-word, a
   * request verb, a reply noun, a negation, the closed filler set) — nothing else rides on it.
   * Only a bare request skips the classifier; any other one is classified, so distress, abuse or
   * a jobs / résumé ask said in the same breath is read as such.
   */
  readonly bare: boolean;
}

/**
 * AN EXPLICIT REQUEST TO REPLY IN A LANGUAGE (R41), or null. Phrased in Hinglish ("marathi mai
 * jawab do", "tamil me bolo", "english mein baat karo", "hindi mein bolo" → `hinglish`), in English
 * ("reply in Tamil", "speak English", "can you answer in Telugu") or in the language itself
 * ("marathit bola", "gujarati ma bolo", "Tamil-la sollunga", "telugu lo cheppandi",
 * "kannadadalli heli"), in Latin letters or the language's script.
 *
 * NOT a request: a message that only mentions a language ("main marathi hoon", "tamil nadu mein
 * kaam", "mujhe english nahi aati", "tamil me kaam karna hai" — a generic verb beside content is
 * not aimed at the reply), a long message about one, or a negated one ("english mein mat bolo").
 * When a message names two, the first one asked for wins ("english mein nahi, hindi mein bolo"
 * asks for Hindi).
 */
export function parseLanguageRequest(text: string): LanguageRequest | null {
  const tokens = languageTokens(text);
  if (tokens.length === 0 || tokens.length > REQUEST_MAX_TOKENS) return null;
  const bare = tokens.every((token) => NAME_INDEX.has(token) || REQUEST_GRAMMAR.has(token));
  for (let i = 0; i < tokens.length; i++) {
    const named = NAME_INDEX.get(tokens[i]!);
    if (named !== undefined && requestsAt(tokens, i, named.glued, bare)) {
      return { language: named.language, bare };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The ask's answer, typed (R41): "Haan" / "Nahi" in the worker's own words
// ---------------------------------------------------------------------------

const YES_WORDS = wordSet(LANGUAGE_YES_WORDS);
const NO_WORDS = wordSet(LANGUAGE_NO_WORDS);
const HONORIFICS = wordSet(ANSWER_HONORIFIC_WORDS);
const YES_PHRASES: ReadonlySet<string> = new Set(
  LANGUAGE_YES_PHRASES.map(([a, b]) => `${normalizeToken(a)} ${normalizeToken(b)}`),
);

/** A typed answer is a short reply; anything longer is a message, and the offer lapses. */
export const LANGUAGE_ANSWER_MAX_TOKENS = 4;

/**
 * A TYPED answer to the ask for `offer`, or null — the chip's key and label are read by the
 * router beside the other chips. An answer is a yes or no word (or "theek hai") followed ONLY by
 * the OFFERED language's name and "mein"-type words, with "ji" allowed on either side: "haan",
 * "haan ji", "ji nahi", "haan marathi mein", "ho". Anything else is null — "accha salary kitni
 * hai", "ok, salary batao", "ho gaya", "haan marna hai", "nahi jeena mujhe", "haan, tamil mein" to
 * a Marathi ask — and the offer lapses silently: the message goes through the normal flow,
 * classifier included.
 */
export function readTypedLanguageAnswer(
  text: string,
  offer: FreeChatReplyLanguage,
): "yes" | "no" | null {
  const tokens = languageTokens(text);
  if (tokens.length === 0 || tokens.length > LANGUAGE_ANSWER_MAX_TOKENS) return null;
  const core = tokens.filter((token) => !HONORIFICS.has(token));
  // "ji" alone (or "ji ji") is the respectful yes.
  if (core.length === 0) return "yes";
  const phrase = core.length >= 2 && YES_PHRASES.has(`${core[0]} ${core[1]}`);
  const polarity = phrase || YES_WORDS.has(core[0]!) ? "yes" : NO_WORDS.has(core[0]!) ? "no" : null;
  if (polarity === null) return null;
  const tail = core.slice(phrase ? 2 : 1);
  return tail.every((token) => LOCATIVES.has(token) || NAME_INDEX.get(token)?.language === offer)
    ? polarity
    : null;
}
