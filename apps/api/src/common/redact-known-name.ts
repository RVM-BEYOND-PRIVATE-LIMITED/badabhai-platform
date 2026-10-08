/**
 * R32 — redact the worker's OWN, KNOWN name out of free text before it leaves the
 * API for the ai-service.
 *
 * WHY THIS SHAPE, AND THE APPROACH THAT WAS MEASURED DEAD.
 * The obvious fix for "a worker's name reaches LLM input" is to teach the
 * pseudonymization gateway to RECOGNISE Indian names (a gazetteer + wider cue
 * regexes). That was built and measured with 487 probes: 348 still leaked —
 * regional names, Devanagari/Tamil script, fullwidth Latin, zero-width joiners and
 * diacritics all defeated it — while the widened cues newly MASKED real trade
 * vocabulary ("Wire EDM", "Jyoti CNC", "Kiran brand") and BLOCKED a legitimate turn
 * ("ITI fitter 2018-2020 kiya"). It is reverted. Do NOT reintroduce a name
 * gazetteer or broaden the ai-service's name heuristics — that direction is closed.
 *
 * This helper does the opposite and only what is actually knowable: it redacts the
 * ONE name we already hold. `workers.full_name` is decrypted server-side in apps/api
 * for `renderWorkerName` (AI-PERSONA-2), so at the egress point the caller has the
 * exact string to remove. No guessing, no gazetteer, no script coverage problem —
 * whatever the worker's name is written in, we are matching the stored value.
 *
 * WHY IT LIVES IN apps/api AND NOT THE ai-service. The ai-service must keep never
 * holding a real name; that is the existing AI-PERSONA-2 architecture (the vocative
 * crosses the boundary as the literal `{{worker_name}}` token and is interpolated
 * back only in the API's client-facing return). Shipping the name INTO the
 * ai-service so it could redact there would invert that property. So the redaction
 * happens on this side, before the hop.
 *
 * THIS IS DEFENCE IN DEPTH, NOT A REPLACEMENT GATE. The ai-service's
 * `pseudonymize()` still runs fail-closed in front of every LLM call while
 * `AI_RAW_PII_ENABLED` is off (ADR-0047). This narrows one class it provably cannot
 * catch; it does not license removing anything downstream.
 *
 * NOT KEYED ON `AI_RAW_PII_ENABLED` (ADR-0047, ruling G2). Armed, the ai-service's
 * prompt maskers pass text through, but every caller still removes the known name:
 * the extraction (`ProfileExtractionProcessor.redactedConversation` — the transcript and
 * the parse call's answer map) and both interview turns (`LlmTurnService.take`,
 * `SkillsTurnService.take`, via `redactedTurnText`). No
 * model there needs it, and a name one reads it can echo into a value it authors — a
 * turn's `role_label` settles as the worker's trade — that reaches the employer copy,
 * where the name shows as initials until an unlock.
 *
 * ACCEPTED TRADEOFF (deliberate, not an oversight): a worker whose own name collides
 * with trade vocabulary loses that token. A worker actually named "Kiran" who writes
 * "Kiran brand ka machine" gets "[NAME] brand ka machine"; a worker named "Steel"
 * loses "steel". The collision is bounded to that ONE worker's own turns and to
 * their own name, and the extraction the loss could degrade is theirs alone. Privacy
 * wins: it is their name, and leaking it is the thing R32 exists to stop.
 *
 * HOW THE NAME IS READ (#2166) is {@link knownNameMatcher}'s doc: dotted, hyphenated, apostrophe,
 * digit-glued, invisible-character, compatibility-form and non-NFC names, and what is deliberately
 * NOT matched.
 */

import { foldAwayMarks, foldName, foldText, nameWordParts } from "./name-fold";

/**
 * What a redacted name token becomes. Deliberately NOT `[PERSON_1]`: the
 * ai-service's own gateway mints that family, and keeping them distinct means a
 * trace can tell "the API knew this name and removed it" apart from "the gateway
 * guessed". Carries no digits, so it can never feed the residual-digit net.
 */
export const REDACTED_NAME_PLACEHOLDER = "[NAME]";

/**
 * Name tokens shorter than this are NOT redacted.
 *
 * Load-bearing: Indian stored names routinely carry initials ("R Suresh Kumar",
 * "K. M. Ramesh"). Redacting a 1-2 character token would rewrite every "R", "ka",
 * "me" and "hai" in the message and shred the text the extractor reads — the exact
 * over-masking regression class that killed the gazetteer attempt. 3 is the shortest
 * length at which a token is a name rather than a letter.
 *
 * Exported for the free-chat probe's residue check (ADR-0051 §10), which must read a name's
 * tokens exactly as this redaction does.
 */
export const MIN_TOKEN_LENGTH = 3;

/**
 * Redact every occurrence of `fullName` — as a whole, and each of its parts
 * independently — from `text`. The rules are {@link knownNameMatcher}'s.
 *
 * FAIL SAFE, NOT CLOSED: a null/blank/unusable name returns `text` UNCHANGED, and so
 * does a name the matcher cannot be built for; this never throws. A decrypt failure
 * upstream must never break a chat turn. Callers log the failure WITHOUT the value.
 */
export function redactKnownName(text: string, fullName: string | null | undefined): string {
  if (typeof text !== "string" || text.length === 0) return text;
  return redactSafely(safeMatcher(fullName), text);
}

/**
 * {@link redactKnownName} over every line of a conversation: the same lines in the same order,
 * each a NEW object with its `text` redacted and every other field carried through. The input is
 * never mutated — a caller's stored copy stays exactly what the worker typed.
 */
export function redactKnownNameLines<T extends { readonly text: string }>(
  lines: readonly T[],
  fullName: string | null | undefined,
): T[] {
  const matcher = safeMatcher(fullName);
  return lines.map((line) => ({ ...line, text: redactSafely(matcher, line.text) }));
}

/**
 * {@link redactKnownName} over every string inside a JSON-shaped value, at any depth: a string,
 * each array item, each object key and value. Numbers, booleans and null come back as they are.
 * The input is never mutated.
 *
 * Keys are walked because a value typed `unknown` promises nothing about who wrote them — the same
 * reason the parse gates' `stringsIn` reads keys. JSON has no cycles, so the recursion is bounded.
 */
export function redactKnownNameDeep(value: unknown, fullName: string | null | undefined): unknown {
  const matcher = safeMatcher(fullName);
  return matcher === null ? value : redactDeep(value, matcher);
}

function redactDeep(value: unknown, matcher: KnownNameMatcher): unknown {
  if (typeof value === "string") return redactSafely(matcher, value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, matcher));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactSafely(matcher, key),
        redactDeep(item, matcher),
      ]),
    );
  }
  return value;
}

/**
 * The worker's decrypted `full_name` ON DEMAND — `null` when none is stored or it cannot be
 * decrypted.
 *
 * A THUNK, NOT THE STRING. Most interview turns make no model call, so an eager read would
 * decrypt a name nothing uses; and a function cannot ride into a buffer, an event or a log line by
 * being spread or serialised with the object that carries it — the plaintext exists only where an
 * egress awaits it.
 */
export type KnownNameSource = () => Promise<string | null>;

/**
 * `read`, run at most once per request, so the interview model's egress and the chat reply's
 * vocative share ONE lookup and ONE decrypt. A REJECTED read is not kept: the next caller retries
 * it, exactly as it would have when each consumer read the name for itself.
 */
export function knownNameOnce(read: () => Promise<string | null>): KnownNameSource {
  return onceRetrying(read);
}

/**
 * `read`, run at most once — a rejected read is NOT kept, so the next caller retries it. The shape
 * {@link knownNameOnce} gives the name; `ChatService` uses it directly for the one name READ that
 * both the fail-open `knownName` and the live-news `ownName` views share (ADR-0054, security M1).
 */
export function onceRetrying<T>(read: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= read().catch((error: unknown) => {
      pending = null;
      throw error;
    });
    return pending;
  };
}

// ---------------------------------------------------------------------------
// The matcher
// ---------------------------------------------------------------------------

/** The worker's own name, compiled once, for every surface that must keep it out of its text. */
export interface KnownNameMatcher {
  /**
   * `text` with every occurrence of the name replaced by {@link REDACTED_NAME_PLACEHOLDER}. Every
   * character outside a replaced span comes back exactly as it went in — nothing is normalised.
   */
  redact(text: string): string;
  /** Does `text` carry the name anywhere {@link redact} would replace it? */
  test(text: string): boolean;
}

/**
 * The matcher {@link redactKnownName} redacts with, or `null` when the name has no usable part.
 * Shared so that every surface that must keep the worker's own name out of its text (the redaction
 * here, the general form's brief screen, the résumé's brief re-check) reads the name the same way.
 * It throws only if the matcher cannot be built at all: the redaction catches that (fail safe), the
 * brief screens let it reach their own `catch` (fail closed).
 *
 * WHAT COUNTS AS THE NAME (#2166). The stored name and the text are both read through
 * `name-fold.ts`: invisibles, compatibility forms, NFC/NFD and the nukta/Latin-diacritic variants
 * read alike, and the text itself is never rewritten outside a matched span. The stored name splits
 * on whitespace into WORDS, and each word into PARTS on anything that is not a letter or a mark
 * (`NAME_SEPARATORS`: a dot, a hyphen, an apostrophe, a digit, a modifier letter). A part of
 * {@link MIN_TOKEN_LENGTH}+ characters (counted NFC, marks included, as written) is LONG. What is
 * matched, first alternative first — JS alternation is first-match-wins at a position, so the order
 * is the whole mechanism that collapses a name to ONE placeholder:
 *
 *   1. the WHOLE name, every part in stored order ("R.K. Ramesh" typed "R K Ramesh");
 *   2. its LONG parts in stored order ("Anil D'Souza" typed "Anil Souza");
 *   3. each multi-part WORD with a long part ("D'Souza", "K.Suresh");
 *   4. each WORD as stored, if it has 3+ characters and a letter or digit ("Raju007", "R.K.") —
 *      the pre-#2166 whitespace token, kept so nothing matched before stops matching;
 *   5. each LONG part on its own ("Suresh", "Prasad").
 *
 * Between two parts of 1–3 a typed name may carry whitespace, an invisible, or the punctuation
 * names are written with ({@link SEPARATOR}). Between two LONG parts, or two parts the stored name
 * joins with an apostrophe, the separator may also be missing ("SureshKumar", "DSouza"). Next to an
 * initial it may not: "S.Aman" must never eat "saman".
 *
 * - CASE-INSENSITIVE: workers type "suresh", the DB holds "Suresh".
 * - WORD-ANCHORED with Unicode lookarounds, unchanged by #2166 (not `\b`, which is ASCII-only):
 *   "Ram" never matches inside "Rampur", "aaram" or "programme", nor "Kumar" inside "kumari". The
 *   lookarounds read letters, digits and `_` only, so a vowel sign after a part does not end the
 *   match: the Bengali "রামের" (Ram's) is redacted, and so is "कुमारी" for a stored "कुमार" — the
 *   whole akshara goes, never half of it.
 * - REPEATED occurrences all go (global match); overlapping spans become one placeholder.
 * - LINEAR: every alternative is a fixed run of literal characters separated by single-class
 *   stars over classes that cannot match the literal after them — no nested quantifier, so no
 *   catastrophic backtracking. The cost is O(text × name); the name DTO caps the name at 100.
 *
 * KNOWN LIMITS (deliberate):
 *   - Mark variants other than the nukta and the Latin diacritics are different words: a stored
 *     "ओम्" (virama) does not match a typed "ओम", nor an anusvara a chandrabindu.
 *   - An initial glued to the name with no separator, when the stored name separates them with a
 *     dot or a hyphen ("KSuresh" for "K.Suresh") is not one placeholder: "Suresh" alone is not
 *     matched either, since "K" precedes it. Gluing an initial would turn "S.Aman" into "saman".
 *   - A stored name whose only separator is an invisible ("Suresh<ZWSP>Kumar", no space) is one
 *     word: typed whole it is redacted, "Suresh" alone is not. A stored invisible is read as what a
 *     soft hyphen is — a break INSIDE a word — or "Sur<SHY>esh" would shred every "sur".
 *   - The parts must come in stored order to collapse: "Kumar Suresh" is two placeholders.
 *   - A name typed in another script than the one it is stored in (the R32 transliteration line).
 */
export function knownNameMatcher(fullName: string | null | undefined): KnownNameMatcher | null {
  if (typeof fullName !== "string") return null;
  const regex = knownNameRegExp(fullName);
  if (regex === null) return null;
  return {
    redact: (text) => redactWith(regex, text),
    test: (text) =>
      typeof text === "string" && text.length > 0 && foldText(text).shadow.search(regex) !== -1,
  };
}

/**
 * The FAIL-SAFE redaction every `redactKnownName*` caller gets: no matcher, or one that throws while
 * being built or run, leaves the text exactly as it was. `knownNameMatcher` itself does NOT swallow a
 * throw, so the fail-CLOSED screens (the briefs) still see one in their own `catch`.
 */
function safeMatcher(fullName: string | null | undefined): KnownNameMatcher | null {
  try {
    return knownNameMatcher(fullName);
  } catch {
    return null;
  }
}

function redactSafely(matcher: KnownNameMatcher | null, text: string): string {
  if (matcher === null) return text;
  try {
    return matcher.redact(text);
  } catch {
    return text;
  }
}

/**
 * What may sit between two parts of a typed name: whitespace, an invisible (folded to the
 * sentinel), a dot, a hyphen (ASCII, U+2010, U+2011), an apostrophe (ASCII, U+2018, U+2019, the
 * modifier letters U+02BB and U+02BC). Fullwidth forms arrive here already folded. A comma is NOT a
 * separator: "Suresh, Kumar" stays two placeholders, as before.
 */
const SEPARATOR = "[\\s\\uFFFF.'\\u2018\\u2019\\u02BB\\u02BC\\u2010\\u2011-]";
const SEPARATED = `${SEPARATOR}+`;
const SEPARATED_OR_GLUED = `${SEPARATOR}*`;
/** An invisible typed inside a name ("Sur<ZWSP>esh") — the sentinel, between any two characters. */
const INSIDE_A_PART = "\\uFFFF*";
/** A stored separator a typed name commonly drops: "DSouza" for "D'Souza". */
const APOSTROPHES_ONLY = /^['\u2018\u2019\u02BB\u02BC]+$/u;
const WHITESPACE = /\s+/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** One part of the stored name, folded for matching. */
interface NamePart {
  readonly needle: string;
  readonly long: boolean;
  readonly word: number;
  /** Joined to the previous part of the SAME word by apostrophes only. */
  readonly glued: boolean;
}

/** Escape a literal so it can be embedded in a RegExp source. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Code points once composed — the length a part has as written. */
function isLong(value: string): boolean {
  return Array.from(value.normalize("NFC")).length >= MIN_TOKEN_LENGTH;
}

/** A literal, escaped code point by code point, that tolerates an invisible between any two. */
function literal(needle: string): string {
  return Array.from(needle, (char) => escapeRegExp(char)).join(INSIDE_A_PART);
}

/** Parts in order, each joined to the one before by what may separate them in typed text. */
function sequence(parts: readonly NamePart[]): string {
  let source = "";
  let previous: NamePart | null = null;
  for (const part of parts) {
    if (previous !== null) {
      source += (previous.long && part.long) || part.glued ? SEPARATED_OR_GLUED : SEPARATED;
    }
    source += literal(part.needle);
    previous = part;
  }
  return source;
}

function letters(value: string): number {
  return Array.from(value).length;
}

function knownNameRegExp(fullName: string): RegExp | null {
  const words = foldName(fullName)
    .split(WHITESPACE)
    .filter((word) => word.length > 0);
  const parts: NamePart[] = [];
  const storedWords: string[] = [];
  words.forEach((word, index) => {
    if (isLong(word) && LETTER_OR_DIGIT.test(word)) storedWords.push(foldAwayMarks(word));
    for (const { part, separatorBefore } of nameWordParts(word)) {
      const needle = foldAwayMarks(part);
      if (needle.length === 0) continue;
      const previous = parts.at(-1);
      parts.push({
        needle,
        long: isLong(part),
        word: index,
        glued: previous?.word === index && APOSTROPHES_ONLY.test(separatorBefore),
      });
    }
  });
  const long = parts.filter((part) => part.long);
  if (long.length === 0 && storedWords.length === 0) return null;

  const ordered: string[] = [];
  if (long.length > 0 && parts.length > 1) ordered.push(sequence(parts));
  if (long.length > 1 && long.length < parts.length) ordered.push(sequence(long));
  const rest: { readonly source: string; readonly length: number }[] = [];
  words.forEach((_, index) => {
    const wordParts = parts.filter((part) => part.word === index);
    if (wordParts.length > 1 && wordParts.some((part) => part.long)) {
      const length = wordParts.reduce((sum, part) => sum + letters(part.needle), 0);
      rest.push({ source: sequence(wordParts), length });
    }
  });
  for (const word of storedWords) rest.push({ source: literal(word), length: letters(word) });
  for (const part of long)
    rest.push({ source: literal(part.needle), length: letters(part.needle) });
  // Longest first, so a word is never cut short by a part it contains ("Ram-Prasad" before "Ram").
  ordered.push(...rest.sort((a, b) => b.length - a.length).map(({ source }) => source));

  const seen = new Set<string>();
  const alternatives = ordered.filter((source) => {
    const key = source.toLowerCase(); // a repeated part in the stored name
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Unicode-aware word anchoring. `\b` is defined on ASCII `\w`, so `\bराम\b` and
  // `\bRam\b` behave inconsistently across the scripts this product actually sees.
  // The lookarounds say exactly what is meant: not adjacent to another letter,
  // digit, or underscore. Matched against the FOLDED text, never the original.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- the stored name is data here, never pattern syntax: every character of it is escaped one code point at a time (`literal` -> `escapeRegExp`), and the only unescaped source is this module's own constant classes and quantifiers. No alternative carries a nested quantifier, so the pattern cannot backtrack catastrophically (pinned by a 20,000-character timing test).
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}_])`, "giu");
}

/**
 * Replace each match of `pattern` in `text`'s fold with the placeholder, mapping it back onto whole
 * units of the original. Spans that overlap (two matches folded from one unit) become one placeholder.
 */
function redactWith(pattern: RegExp, text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  const folded = foldText(text);
  let out = "";
  let cursor = 0;
  let span: readonly [number, number] | null = null;
  for (const match of folded.shadow.matchAll(pattern)) {
    const [start, end] = folded.originalSpan(match.index, match.index + match[0].length);
    if (span !== null && start <= span[1]) {
      span = [span[0], Math.max(span[1], end)];
      continue;
    }
    if (span !== null) {
      out += text.slice(cursor, span[0]) + REDACTED_NAME_PLACEHOLDER;
      cursor = span[1];
    }
    span = [start, end];
  }
  if (span === null) return text;
  return out + text.slice(cursor, span[0]) + REDACTED_NAME_PLACEHOLDER + text.slice(span[1]);
}
