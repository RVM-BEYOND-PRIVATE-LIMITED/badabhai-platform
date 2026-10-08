/**
 * The free-chat probe's MASK (ADR-0051 §10, owner ruling R29) — whether one real stored line may be
 * shown to a person at all, and if so, as what.
 *
 * FAIL CLOSED, WHOLE LINES ONLY. A line is shown with the worker's own name replaced by `[NAME]`, or
 * it is not shown — never half-masked. Every check below can only DROP more; a check that throws
 * counts as a hit. Only the REASON a line was dropped is returned; its text goes nowhere.
 *
 * WHY THIS DOES MORE THAN `redactKnownName`. The security reviews reproduced the shared redaction
 * (R32) failing open on a dotted (`K.Suresh`), hyphenated (`Ram-Prasad`), apostrophe (`D'Souza`,
 * `DʼSouza`), digit-glued (`Raju007`) or invisible-character (`Suresh<ZWSP>`, a soft hyphen, U+034F)
 * stored name, on compatibility forms (fullwidth `Ｓｕｒｅｓｈ`, math bold `𝐒𝐮𝐫𝐞𝐬𝐡`), and on a name
 * stored precomposed but typed decomposed (`ज़` U+095B vs `ज` + nukta). #2166 closed those in the
 * shared helper, which now reads the name with the same separators and invisibles as this file
 * (`name-fold.ts`). A line a person reads still gets more than a model's input does: the probe
 * normalises the NAME exactly as it normalises the TEXT (invisibles out, NFKC), splits it into
 * sub-tokens of letters, masks with those, and then DROPS the line if any of them is still there in
 * any form — including spellings that differ only in a mark the redaction keeps (a virama).
 */
import { codePointCount, INVISIBLE, NAME_SEPARATORS } from "../../common/name-fold";
import {
  MIN_TOKEN_LENGTH,
  REDACTED_NAME_PLACEHOLDER,
  redactKnownName,
} from "../../common/redact-known-name";
import { carriesNewsIdentifier, foldDecimalDigits } from "./free-chat-news";

/** A shown line is cut to this many code points, AFTER masking — so a cut can never split a name. */
export const SAMPLE_LINE_MAX_CHARS = 200;

/** Why a line was not shown. Counted; the line itself goes nowhere. */
export const LINE_DROP_REASONS = [
  "identifier",
  "name_cue",
  "name_unreadable",
  "name_tokens_found",
] as const;
export type LineDropReason = (typeof LINE_DROP_REASONS)[number];

export type MaskedLine =
  | { readonly kind: "shown"; readonly text: string }
  | { readonly kind: "dropped"; readonly reason: LineDropReason };

// ---------------------------------------------------------------------------
// Normalisation — the same for the text and the name
// ---------------------------------------------------------------------------

// `INVISIBLE` (name-fold.ts): every format character and every default-ignorable code point —
// invisible, able to split a name, and able to reorder a terminal line. Shared with the redaction.
const WHITESPACE_RUNS = /\s+/gu;

/**
 * Invisibles out, NFKC (fullwidth and math-alphanumeric letters fold to their plain twins), whitespace
 * collapsed — applied to the text AND the stored name. Invisibles are stripped on both sides of the
 * NFKC because it can MAKE one (U+3164 becomes U+1160, itself default-ignorable).
 */
export function normaliseForMask(value: string): string {
  return value
    .replace(INVISIBLE, "")
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(WHITESPACE_RUNS, " ")
    .trim();
}

/**
 * {@link normaliseForMask} with each invisible turned into a SPACE instead of removed — the name-cue
 * check reads both, so "naam<ZWSP>Ramesh" (two words once spaced) and "na<ZWSP>am Ramesh" (one cue
 * word once removed) are both cues.
 */
function spacedForCue(value: string): string {
  return value
    .replace(INVISIBLE, " ")
    .normalize("NFKC")
    .replace(INVISIBLE, " ")
    .replace(WHITESPACE_RUNS, " ")
    .trim();
}

/**
 * THE ONE BLANK RULE for a stored line, worker's or bot's: nothing left once normalised. Decided here
 * in JS only — never in SQL, whose `btrim`/`\s` do not agree with JavaScript's whitespace.
 */
export function isBlankLine(value: string): boolean {
  return normaliseForMask(value) === "";
}

/** Case-folded, for comparing a name sub-token with the text. */
function folded(value: string): string {
  return value.toLowerCase().normalize("NFKC");
}

// `NAME_SEPARATORS` (name-fold.ts): where a name (or a word of the text, for the whole-word rule)
// splits — anything that is not a letter or a combining mark, AND every digit and modifier letter:
// `Raju007` → `Raju`; `DʼSouza` (U+02BC, a modifier letter) → `D`, `Souza`; `98765 43210` → nothing
// at all. The SAME split the redaction reads the stored name with.

/** The stored name's sub-tokens: `K.Suresh` → `K`, `Suresh`; `Suresh2 Kumar` → `Suresh`, `Kumar`. */
export function nameSubTokens(name: string): string[] {
  return normaliseForMask(name)
    .split(NAME_SEPARATORS)
    .filter((token) => token.length > 0);
}

/**
 * How many LETTERS a sub-token has: its code points (`codePointCount`, shared with the redaction),
 * each a letter or a combining mark — so the Devanagari राम (र, the vowel sign ा, म) counts three, as
 * its Latin twin "Ram" does. A token is built only of those (see {@link NAME_SEPARATORS}), so no digit
 * or modifier letter ever counts.
 */
const letterCount = codePointCount;

/** A sub-token the line can be masked with: {@link MIN_TOKEN_LENGTH}+ letters. */
const isMaskable = (token: string) => letterCount(token) >= MIN_TOKEN_LENGTH;

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * A line with this many digits in total — after NFKC and the Indic-digit fold — is dropped whatever
 * the scanners say. Nine is below a phone (10), an Aadhaar (12) and most account numbers, and the
 * scanners can be beaten by separators they do not know ("98765/43210", "9876 / 543210"); counting
 * digits cannot. It also drops some lines that carry only amounts — that costs coverage, not privacy.
 */
const MAX_DIGITS = 9;
const ASCII_DIGITS = /\d/g;
/**
 * Separators with a digit on at least one side, removed for a second scan: between two digits
 * ("98765/43210" → "9876543210") and between a letter and a digit ("ABCDE 1234 F" → "ABCDE1234F", a
 * PAN the scanner would otherwise read as three words).
 */
const ALNUM_JOINERS =
  /(?<=[\p{L}\p{N}])[\s/\\.\-–—_]+(?=\p{N})|(?<=\p{N})[\s/\\.\-–—_]+(?=\p{L})/gu;
/** An `@` (or the fullwidth one) followed by a letter: an address with no TLD ("suresh123@gmail"). */
const AT_THEN_LETTER = /[@＠]\s*\p{L}/u;

/**
 * Does the line carry an identifier? `carriesNewsIdentifier` (the live-news wall: `containsHardIdentifier`
 * — a control character or a scanner error counts as a hit — and `looksLikePii`, each over the text and
 * its Indic-digit fold) over the text as stored, as it will print, with the separators next to digits
 * removed, and that upper-cased (a PAN typed in lower case); plus the digit count and the bare `@`.
 * Any throw is a hit.
 */
export function carriesIdentifier(raw: string, text: string): boolean {
  try {
    const digits = foldDecimalDigits(text.normalize("NFKC"));
    const joined = digits.replace(ALNUM_JOINERS, "");
    return (
      (digits.match(ASCII_DIGITS)?.length ?? 0) >= MAX_DIGITS ||
      AT_THEN_LETTER.test(text) ||
      [raw, text, joined, joined.toUpperCase()].some((value) => carriesNewsIdentifier(value))
    );
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Name cues
// ---------------------------------------------------------------------------

/**
 * A NAME CUE — a word for "name" followed (after any spaces, punctuation, symbols or digits, and an
 * optional `'s`) by a word: "mera naam Ramesh", "my name's Ramesh", "naam (Ramesh)", "naam 1 Ramesh",
 * "माझं नाव रमेश", "আমার নাম রমেশ". The line is dropped rather than masked (R29): the word after a cue
 * is usually a name, often NOT the worker's own, and there is nothing to match it against.
 *
 * The words: Hindi/Hinglish `na+m` (nam, naam, naaam), English `name`, नाम, Marathi नाव/नांव/`na+v`
 * (nav, naav) and माझे ("my"), Bengali নাম, Punjabi ਨਾਮ/ਨਾਂ, Gujarati નામ, Tamil பெயர்/பேர்/peyar/peyru,
 * Telugu పేరు/peru, Kannada ಹೆಸರು/hesaru/hesru, Malayalam പേര്, Urdu نام — and `per` ONLY after
 * `en`/`என்` ("en per Ramesh"), so "per day" is not one. Word-anchored with Unicode classes (marks
 * included, so a matra continues a word): "Naman", "namaste" and "username" are not cues, and a cue
 * with nothing after it ("aapka naam?") is not one either. Literal, `u`-flagged (SAST).
 */
const NAME_CUE =
  /(?<![\p{L}\p{M}\p{N}_])(?:na+m|name|na+v|peyar|peyru|peru|hesaru|hesru|नाम|नाव|नांव|माझे|নাম|ਨਾਮ|ਨਾਂ|નામ|பெயர்|பேர்|పేరు|ಹೆಸರು|പേര്|نام|(?<=(?:^|[^\p{L}\p{M}\p{N}_])(?:en|என்)\s+)per)(?![\p{L}\p{M}\p{N}_])(?:['’]s)?[\s\p{P}\p{S}\p{N}]*[\p{L}\p{M}]/iu;

/** A cue in the line, read with its invisibles removed AND with them as spaces. */
function carriesNameCue(raw: string, text: string): boolean {
  return NAME_CUE.test(text) || NAME_CUE.test(spacedForCue(raw));
}

// ---------------------------------------------------------------------------
// The mask
// ---------------------------------------------------------------------------

/**
 * The vocative placeholder an assistant line is STORED with (`ChatService`'s
 * `WORKER_NAME_PLACEHOLDER`, SG-1): the real name is interpolated only into the live reply, so a
 * flushed bot line carries this token and is printed with `[NAME]` in its place.
 */
const WORKER_NAME_TOKEN = /\{\{worker_name\}\}/g;

/** A two-letter name sub-token ("Om") is dropped on as a WHOLE word only — anywhere would be every "om". */
const SHORT_TOKEN_LETTERS = 2;

/**
 * One stored line → the text a person may read, or why it may not be shown. THE ORDER IS THE POLICY:
 *
 *   1. AN IDENTIFIER ({@link carriesIdentifier}).
 *   2. A NAME CUE ({@link NAME_CUE}), with invisibles removed and as spaces.
 *   3. AN UNREADABLE NAME: none on file, blank, a failed decrypt (the caller reads all three as null),
 *      or a name with no sub-token of 3+ letters to mask with — `98765 43210` is not a name.
 *   4. MASK: `redactKnownName` with the STORED name — the shared reading keeps its words, its
 *      apostrophe joins ("DSouza") and its dotted initials (#2166) — and the stored vocative → `[NAME]`.
 *   5. NAME TOKENS FOUND: any sub-token of 3+ letters still ANYWHERE in the case-folded text (glued to
 *      a word, or an ordinary word that contains it — a false drop costs a line, never a name), or a
 *      two-letter sub-token as a WHOLE word ("Om" for "Om Prakash"); a one-letter token never. Checked
 *      twice: as normalised, and again with every combining mark stripped from both sides, so a
 *      spelling that differs only in marks is caught (see {@link carriesNameTokens}).
 *   6. Cut to {@link SAMPLE_LINE_MAX_CHARS} — after masking, so a cut never exposes half a name.
 */
export function maskSampleLine(raw: string, knownName: string | null): MaskedLine {
  const text = normaliseForMask(raw);
  if (carriesIdentifier(raw, text)) return { kind: "dropped", reason: "identifier" };
  if (carriesNameCue(raw, text)) return { kind: "dropped", reason: "name_cue" };
  const tokens = knownName === null ? [] : nameSubTokens(knownName);
  if (!tokens.some(isMaskable)) return { kind: "dropped", reason: "name_unreadable" };
  const masked = redactKnownName(text, knownName).replace(
    WORKER_NAME_TOKEN,
    () => REDACTED_NAME_PLACEHOLDER,
  );
  if (carriesNameTokens(masked, tokens)) return { kind: "dropped", reason: "name_tokens_found" };
  return { kind: "shown", text: truncate(masked, SAMPLE_LINE_MAX_CHARS) };
}

/** Every combining mark: nukta, virama, vowel signs, and any diacritic NFKC left decomposed. */
const COMBINING_MARKS = /\p{M}/gu;

/** One name token left in the text: 3+ letters anywhere, 2 as a whole word, 1 never. */
function leftIn(needle: string, text: string, words: ReadonlySet<string>): boolean {
  const letters = letterCount(needle);
  if (letters >= MIN_TOKEN_LENGTH) return text.includes(needle);
  return letters === SHORT_TOKEN_LETTERS && words.has(needle);
}

/**
 * Rule 5 of {@link maskSampleLine}, over the masked text with its placeholders taken out — AS
 * NORMALISED, and again with every combining mark STRIPPED from the text and the token alike.
 *
 * WHY THE SECOND PASS. Workers routinely leave marks out: a stored `ओम्` (virama) typed `ओम`, Tamil
 * `ஓம்` typed `ஓம`. The masking folds away only the nukta and the Latin diacritics (#2166: a stored
 * `ज़ाकिर` typed `जाकिर` is now masked), so it cannot match those spellings and the line must be
 * dropped — and only a comparison without marks sees them. The stripped token
 * is judged by what is left: 3+ letters anywhere, 2 letters as a whole word (`ओम्` → `ओम`), 1 never.
 * The first pass is kept, unchanged, so nothing it caught before is lost (a glued `रामकुमार` for a
 * stored `राम`: three letters with its vowel sign, but only two once stripped).
 */
function carriesNameTokens(masked: string, tokens: readonly string[]): boolean {
  const rest = folded(masked.split(REDACTED_NAME_PLACEHOLDER).join(" "));
  const bare = rest.replace(COMBINING_MARKS, "");
  const words = new Set(rest.split(NAME_SEPARATORS));
  const bareWords = new Set(bare.split(NAME_SEPARATORS));
  return tokens.some((token) => {
    const needle = folded(token);
    return (
      leftIn(needle, rest, words) || leftIn(needle.replace(COMBINING_MARKS, ""), bare, bareWords)
    );
  });
}

/** At most `max` code points (never half a surrogate pair), with an ellipsis when cut. */
function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}
