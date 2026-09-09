/**
 * ══════════════════════════════════════════════════════════════════════════════════════
 * PROPER-NOUN CASING FOR WORKER-TYPED NAMES AND PLACES (owner ruling 2026-09-08).
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * THE PROBLEM IS THE KEYBOARD, NOT THE WORKER. Every employer name and every place on this
 * sheet is typed by hand, on a phone, by someone whose first language is not written in Latin
 * script — so `sandhar technologies pvt ltd` and `faridabad` are the ordinary input, not the
 * exception. Printed verbatim they make a worker's résumé look like a form dump on the one
 * document he hands across a factory gate, and the employer reads that as carelessness by the
 * worker. The ruling: *"Work history where company name is there I want the first letter of each
 * word in company letter to be capital. Also the location's first letter should be capital."*
 *
 * ── WHY THIS IS NOT A §8 FABRICATION ──────────────────────────────────────────────────
 *
 * §8 governs the SOURCE of a printed string: a closed-vocabulary label, a number the worker
 * stated, or the worker's own words. This changes neither the source nor the word — it is the
 * same word, and the shape-matrix fixture header already states the rule it lives under: "the
 * pipeline may reshape a worker's words, and may NEVER ADD TO THEM". Nothing here adds, drops,
 * translates, expands or corrects: `sandhar` becomes `Sandhar` and never `Sandhar Technologies`.
 * The fabrication gate's containment is case-insensitive for exactly this reason.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────────────────
 *
 * IT NEVER LOWERCASES ANYTHING. Only a lowercase letter in a leading position is touched; every
 * other character is passed through byte-for-byte. That single rule is what keeps `TVS`, `JBM`,
 * `NCVT`, `UAE` and `L&T` intact — a naive `word[0].toUpperCase() + word.slice(1).toLowerCase()`
 * turns an Indian manufacturer's own name into `Tvs`, and an acronym mangled on a résumé is
 * worse than the lowercase it replaced, because it reads as a different company.
 *
 * IT KNOWS NO EXCEPTION LIST. There is no "pvt/ltd/of/and stay lowercase" table, because English
 * title-case conventions are not what this is for and a table would be a second, worse
 * vocabulary to maintain — the worker's own list of employers is not a closed set.
 *
 * IT TOUCHES ONLY NAMES AND PLACES. Role labels, work descriptions and the worker's own quoted
 * sentences are NOT run through this: `cnc turner` would become `Cnc Turner`, which is a
 * misspelling of a trade, and capitalising the middle of a Hinglish sentence would be the
 * renderer editing the one thing on the sheet that is verbatim by contract.
 *
 * NON-LATIN SCRIPT IS UNAFFECTED. Devanagari has no case, so `\p{Ll}` matches nothing in
 * `फरीदाबाद` and the string passes through untouched.
 */

/**
 * Word boundaries after which a lowercase letter is raised.
 *
 * SPACE, HYPHEN (all three dashes), OPENING PARENTHESIS AND AMPERSAND — and the set is short on
 * purpose, because every character added to it is a new way to be wrong:
 *
 *   `'` IS EXCLUDED — `shri ram's auto` would print `Shri Ram'S Auto`.
 *   `/` IS EXCLUDED — `m/s sharma engineering` would print `M/S Sharma`, where the conventional
 *       abbreviation is `M/s`. Leaving it out yields `M/s Sharma Engineering`, which is right.
 *   `.` IS EXCLUDED — a trailing dot before a space is already covered by the space, and treating
 *       it as a boundary would raise the letter after a decimal point.
 */
const WORD_START = /(^|[\s\-–—(&])(\p{Ll})/gu;

/**
 * `sandhar technologies pvt ltd` → `Sandhar Technologies Pvt Ltd`; `TVS` → `TVS`.
 *
 * TOTAL AND NULL-SAFE, so call sites do not each grow a guard: null, undefined and blank come
 * back unchanged, because a name that is not there must not become an empty string that prints
 * as a stray separator.
 */
export function titleCaseName<T extends string | null | undefined>(value: T): T {
  if (typeof value !== "string" || value === "") return value;
  return value.replace(
    WORD_START,
    (_, lead: string, letter: string) => lead + letter.toUpperCase(),
  ) as T;
}
