/**
 * The TypeScript half of the lexicon reader. Mirrors
 * `apps/ai-service/app/profiling/lexicon.py` function for function.
 *
 * These two files are the ONLY place a lexicon pattern is turned into a matcher, which is what
 * makes "one JSON file, two engines" true rather than aspirational. Anything added here must be
 * added there in the same commit — the parity corpus in `__fixtures__/utterances.jsonl` is what
 * turns a one-sided change red.
 */

import { readLexiconFile } from "./data.generated.js";

/**
 * What counts as a "word character" for the `{WB}` / `{WE}` boundary macros.
 *
 * Reproduces Python's `\w` over the text this corpus contains, because the extraction from
 * `signals.py` has to be behaviour-preserving. ASCII alphanumerics + `_` is `\w`'s ASCII
 * behaviour, which both engines implement identically.
 *
 * The Devanagari part is ENUMERATED, not taken as the whole U+0900–U+097F block, because
 * Python's `\w` is `str.isalnum()`-backed and the block is not all alphanumeric:
 *
 * ```
 *   U+0904-U+0939  letters (Lo)                WORD
 *   U+093A-U+093C  combining marks             not word
 *   U+093D         avagraha (Lo)               WORD
 *   U+093E-U+094F  matras + virama (Mn/Mc)     not word
 *   U+0950         om (Lo)                     WORD
 *   U+0951-U+0957  accents (Mn)                not word
 *   U+0958-U+0961  letters (Lo)                WORD
 *   U+0962-U+0963  vocalic marks (Mn)          not word
 *   U+0964-U+0965  DANDA + double danda (Po)   not word   <-- the one that bites
 *   U+0966-U+096F  digits (Nd)                 WORD
 *   U+0970         abbreviation sign (Po)      not word
 *   U+0971         high spacing dot (Lm)       WORD
 *   U+0972-U+097F  letters (Lo)                WORD
 * ```
 *
 * The danda `।` ends a Hindi sentence the way `.` ends an English one, so it lands directly
 * after the tokens these detectors match. Treating it as a word character kills the trailing
 * boundary and "idk।" stops matching — measured against the pre-extraction patterns, 15
 * regressions, every one a danda.
 *
 * Escapes, not glyphs, so the ranges are auditable without trusting a font or an encoding.
 */
const BOUNDARY_CLASS =
  "0-9A-Za-z_" +
  "ऄ-ह" + // letters
  "ऽ" + // avagraha
  "ॐ" + // om
  "क़-ॡ" + // letters
  "०-९" + // digits
  "ॱ-ॿ"; // high spacing dot + letters

const WB = `(?<![${BOUNDARY_CLASS}])`;
const WE = `(?![${BOUNDARY_CLASS}])`;

/**
 * One word CHARACTER, as opposed to the two boundary ASSERTIONS above. Stands in for a bare
 * `\w`, which the subset rule bans: the salary and availability cue lists are full of open-ended
 * stems (`annual\w*`, `month\w*`, `expect\w*`) that must keep matching the same text in both
 * engines. `{WC}*` is the direct replacement for `\w*`.
 */
const WC = `[${BOUNDARY_CLASS}]`;

/**
 * Only the characters that are a JavaScript `SyntaxCharacter` AND a Python metacharacter.
 *
 * Space, `-` and `&` are deliberately absent: they are literal outside a character class in both
 * engines, and `\-` is a *SyntaxError* in a `u`-mode pattern. Python's `re.escape` does escape
 * them, which is why a composed source is not byte-identical to the string `signals.py` used to
 * build inline — only semantically identical, which is what the parity corpus asserts.
 */
const ESCAPE_CHARS = new Set([
  ".",
  "*",
  "+",
  "?",
  "^",
  "$",
  "(",
  ")",
  "{",
  "}",
  "[",
  "]",
  "|",
  "\\",
]);

/**
 * Catches a typo'd or newly-invented macro before it reaches the regex compiler as a literal
 * `{FOO}` — which is *valid* regex syntax, so it would not throw. It would simply never match,
 * and a detector that never fires is the exact silent failure this package exists to prevent.
 * Deliberately does not match a quantifier like `{0,24}`.
 */
const UNEXPANDED_MACRO_RE = /\{[A-Z][A-Z0-9_]*\}/;

/** One `{ source, flags }` object as it appears in a lexicon file. */
export interface PatternSpec {
  readonly source: string;
  readonly flags?: string;
}

interface SkillsFile {
  readonly skills: readonly {
    readonly keyword: string;
    readonly label: string;
    readonly id: string;
  }[];
}

interface ExperienceFile {
  readonly wordNumbers: readonly { readonly word: string; readonly value: number }[];
}

/** Regex-escape a literal using the JS/Python-common escape set. */
function escapeForBothEngines(literal: string): string {
  let out = "";
  for (const ch of literal) out += ESCAPE_CHARS.has(ch) ? `\\${ch}` : ch;
  return out;
}

const fileCache = new Map<string, unknown>();

/**
 * Load one lexicon file by stem. Throws on an unknown stem rather than degrading to `{}`: a
 * missing gazetteer must not turn every detector into a silent no-op. CLAUDE.md §3 — fail closed.
 */
export function loadLexicon<T>(stem: string): T {
  const cached = fileCache.get(stem);
  if (cached !== undefined) return cached as T;
  const parsed = readLexiconFile<T>(stem);
  fileCache.set(stem, parsed);
  return parsed;
}

let skillAlternation: string | undefined;

/** The `skills.json` keywords, in file order. ORDER IS LOAD-BEARING (see that file). */
export function skillKeywords(): readonly string[] {
  return loadLexicon<SkillsFile>("skills").skills.map((entry) => entry.keyword);
}

function skillKeywordAlternation(): string {
  skillAlternation ??= skillKeywords().map(escapeForBothEngines).join("|");
  return skillAlternation;
}

let expAlternation: string | undefined;

/**
 * The spelled-out experience quantities, in file order. ORDER IS LOAD-BEARING: the alternation
 * is longest-first, so "paune do" (1.75) beats "paune" (0.75) and "sava do" (2.25) beats "sava".
 */
export function experienceWords(): readonly { word: string; value: number }[] {
  return loadLexicon<ExperienceFile>("experience").wordNumbers.map((e) => ({
    word: e.word,
    value: e.value,
  }));
}

function experienceWordAlternation(): string {
  expAlternation ??= experienceWords()
    .map((e) => escapeForBothEngines(e.word))
    .join("|");
  return expAlternation;
}

/**
 * Expand the `{WB}` / `{WE}` / `{WC}` / `{SKILL_KEYWORDS}` / `{EXP_WORDS}` macros to their regex
 * source. `lexicon.py` performs the identical substitution — that is what makes one JSON file
 * compile to the same matcher in both languages.
 */
export function expand(source: string): string {
  const expanded = source
    .split("{WB}")
    .join(WB)
    .split("{WE}")
    .join(WE)
    .split("{WC}")
    .join(WC)
    .split("{SKILL_KEYWORDS}")
    .join(skillKeywordAlternation())
    .split("{EXP_WORDS}")
    .join(experienceWordAlternation());

  const leftover = UNEXPANDED_MACRO_RE.exec(expanded);
  if (leftover) {
    throw new Error(
      `unknown lexicon macro ${leftover[0]} in pattern source ${JSON.stringify(source)} — ` +
        "add it to BOTH regex.ts and lexicon.py, never to one side only",
    );
  }
  return expanded;
}

/**
 * Map the data file's flag string onto JavaScript flags.
 *
 * Only `i` is supported, and an unknown flag THROWS rather than being dropped: silently ignoring
 * a flag would change what the pattern matches in one engine only.
 *
 * `u` is deliberately never set. The data uses identity escapes that a `u`-mode pattern rejects,
 * and Python has no equivalent mode, so enabling it would break the parity the package exists for.
 */
function toJsFlags(flags: string): string {
  const unknown = [...flags].filter((flag) => flag !== "i");
  if (unknown.length > 0) {
    throw new Error(`unsupported lexicon regex flag(s): ${JSON.stringify(unknown.sort())}`);
  }
  return flags.includes("i") ? "i" : "";
}

/**
 * Compile one `{ source, flags }` object from a lexicon file.
 *
 * Returns a NON-global RegExp on purpose. A `g` flag carries `lastIndex` between calls, which
 * would make these detectors stateful and their results dependent on call order — the opposite of
 * the purity the orchestrator's property tests rely on.
 */
export function compilePattern(spec: PatternSpec): RegExp {
  return new RegExp(expand(spec.source), toJsFlags(spec.flags ?? ""));
}

/** Compile the pattern at `key` in `stem`.json. */
export function compileNamed(stem: string, key: string): RegExp {
  const file = loadLexicon<Record<string, PatternSpec>>(stem);
  const spec = file[key];
  if (!spec) throw new Error(`lexicon ${stem}.json has no pattern "${key}"`);
  return compilePattern(spec);
}

/**
 * As {@link compilePattern}, but with the `g` flag, for callers that need to walk every match
 * with offsets (tokenizing, span extraction).
 *
 * Kept separate rather than adding `g` to the shared compile path: a global RegExp carries
 * `lastIndex` between calls, so sharing one instance would make results depend on call order.
 * Every caller here creates its own and uses it within a single function body.
 */
export function compilePatternGlobal(spec: PatternSpec): RegExp {
  return new RegExp(expand(spec.source), `${toJsFlags(spec.flags ?? "")}g`);
}
