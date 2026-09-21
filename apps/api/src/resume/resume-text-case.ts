import { ROLE_FORM_DESCRIPTORS } from "../profiling/roles/role-registry";

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

/**
 * ══════════════════════════════════════════════════════════════════════════════════════
 * THE ROLE LABEL — the one headline field whose author is the MODEL (#1434).
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * `canonicalRole` falls through `trade.display_name` → `resolveId(canonical_role_id)` →
 * `draft.role_label`, and for an LLM-led interview the first two are null BY CONSTRUCTION
 * (`toExtractionOutput` hardcodes them). So on every chat-led profile the printed headline is the
 * model's own free text, and the reported defect is exactly that: **"CNC turner · 6 yrs 4 mo"**.
 *
 * ── WHY THIS IS NOT JUST `titleCaseName` ──────────────────────────────────────────────
 *
 * The header above this file is explicit that role labels are OUT of `titleCaseName`'s scope,
 * and it names this exact hazard: *"`cnc turner` would become `Cnc Turner`, which is a
 * misspelling of a trade"*. That warning is correct and it is why this is a separate function
 * rather than one more call site on the old one.
 *
 * `titleCaseName` alone is safe for the REPORTED input and unsafe for its neighbour:
 *
 *     "CNC turner"  -> "CNC Turner"   ✓ the bug, fixed — nothing is ever lowercased
 *     "cnc turner"  -> "Cnc Turner"   ✗ a trade name misspelt on the one page a worker hands over
 *
 * Both are reachable. `role_label` is unconstrained free text — the extraction prompt asks only
 * for *"what they do inside it"* — so the model's casing of an acronym is a coin toss we do not
 * control and must not print the losing side of.
 *
 * ── THE VOCABULARY DECIDES FIRST, CASING ONLY SECOND ──────────────────────────────────
 *
 * We already hold 21 reviewed, correctly-cased role names: every descriptor's `displayName`
 * ("CNC Turner", "Tool and Die Maker"). When the model's label IS one of them — however it cased
 * it — the reviewed spelling is printed and the outcome is right by construction rather than by
 * a casing rule that happens to work. Only a label naming a trade we have no descriptor for
 * (a cook, a driver, the long tail the 21 roles do not cover) falls through to `titleCaseName`,
 * where "never lowercase anything" is the most that can be said safely.
 *
 * NOT A §8 FABRICATION, and the test asserts the boundary: the match is on the WHOLE normalised
 * label, so "CNC turner" resolves and "CNC turner helper" does not — swapping a substring match
 * for the worker's actual words is precisely the addition §8 forbids.
 */
const CANONICAL_ROLE_NAMES: ReadonlyMap<string, string> = new Map(
  ROLE_FORM_DESCRIPTORS.map((d) => [normaliseRoleLabel(d.displayName), d.displayName]),
);

/** Case- and space-insensitive key. Nothing else is stripped — see the §8 note above. */
function normaliseRoleLabel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** `"CNC turner"` → `"CNC Turner"` (reviewed spelling); `"tandoor cook"` → `"Tandoor Cook"`. */
export function titleCaseRoleLabel<T extends string | null | undefined>(value: T): T {
  if (typeof value !== "string" || value === "") return value;
  const canonical = CANONICAL_ROLE_NAMES.get(normaliseRoleLabel(value));
  return (canonical ?? titleCaseName(value)) as T;
}
