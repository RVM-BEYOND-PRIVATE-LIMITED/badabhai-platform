/**
 * City / state / region resolution — ports of `signals._canonical_city`, `_detect_state` and
 * `_detect_region` against the same `data/cities.json` and `data/states.json` the Python side
 * reads.
 *
 * The city gazetteer is DETECTION data, not masking data (owner ruling 2026-07-31): a worker's
 * city is the strongest matching signal this product has and is not identity — "Pune" identifies
 * nobody. `pseudonymize.py` holds the same set for the same reason and now loads it from here,
 * so there is exactly one city list in the system.
 */

import { compilePattern, loadLexicon } from "../internal/regex.js";
import type { NormalizedValue } from "./types.js";
import { applyNegation } from "./negation.js";

interface CitiesFile {
  readonly canonical: readonly string[];
  readonly aliases: Readonly<Record<string, string>>;
}

interface StatesFile {
  readonly names: Readonly<Record<string, string>>;
  readonly abbreviations: Readonly<Record<string, string>>;
  readonly regions: Readonly<Record<string, string>>;
}

const CITIES = loadLexicon<CitiesFile>("cities");
const STATES = loadLexicon<StatesFile>("states");

/**
 * Escape for a regex literal using the JS/Python-common set, and sort LONGEST FIRST.
 *
 * Longest-first is load-bearing in an alternation: without it "delhi" matches inside
 * "new delhi" and the worker's city silently becomes the wrong one. `signals.py` sorts the same
 * way (`sorted(..., key=len, reverse=True)`).
 */
function alternation(tokens: readonly string[]): string {
  return [...tokens]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
}

const CITY_RE = compilePattern({
  source: `{WB}(?:${alternation([...CITIES.canonical, ...Object.keys(CITIES.aliases)])}){WE}`,
  flags: "i",
});

const STATE_NAME_RE = compilePattern({
  source: `{WB}(?:${alternation(Object.keys(STATES.names))}){WE}`,
  flags: "i",
});

/**
 * Abbreviations are matched CASE-SENSITIVELY, and that is deliberate: a case-insensitive "up" /
 * "mp" collides with shop-floor phrasing like "set up" / "setup" and would write a wrong state
 * into the profile. "UP" in caps is a state.
 */
const STATE_ABBREV_RE = compilePattern({
  source: `{WB}(?:${alternation(Object.keys(STATES.abbreviations))}){WE}`,
  flags: "",
});

const REGION_RE = compilePattern({
  source: `{WB}(?:${alternation(Object.keys(STATES.regions))}){WE}`,
  flags: "i",
});

/** Title-case a canonical token for display, matching Python's `str.title()`. */
function titleCase(value: string): string {
  return value.replace(/[A-Za-z]+/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase());
}

function found<T>(value: T, match: RegExpExecArray, text: string): NormalizedValue<T> {
  const span = { start: match.index, end: match.index + match[0].length };
  return { value, span, negationVetoed: overlapsNegation(text, span) };
}

function overlapsNegation(text: string, span: { start: number; end: number }): boolean {
  return applyNegation(text).spans.some(([s, e]) => s < span.end && span.start < e);
}

/**
 * Canonical city, resolved against the gazetteer. `signals._canonical_city`.
 *
 * An alias only ever normalizes to an EXISTING canonical member — "dilli" → "Delhi" — so this is
 * not a loosening of the closed set.
 */
export function canonicalCity(text: string): NormalizedValue<string> | null {
  const match = CITY_RE.exec(text || "");
  if (!match) return null;
  const low = match[0].trim().toLowerCase();
  return found(titleCase(CITIES.aliases[low] ?? low), match, text);
}

/**
 * Canonical state. `signals._detect_state`.
 *
 * Full names win over abbreviations, so "Uttar Pradesh" is not shadowed by a stray "UP".
 */
export function canonicalState(text: string): NormalizedValue<string> | null {
  const message = text || "";
  const byName = STATE_NAME_RE.exec(message);
  if (byName) {
    return found(STATES.names[byName[0].toLowerCase()] as string, byName, message);
  }
  const byAbbrev = STATE_ABBREV_RE.exec(message);
  if (byAbbrev) {
    return found(STATES.abbreviations[byAbbrev[0]] as string, byAbbrev, message);
  }
  return null;
}

/**
 * A named multi-state region ("NCR", "South India"), or null. `signals._detect_region`.
 *
 * Whole phrases only: "south" and "india" on their own say nothing ("south side me rehta hu",
 * "made in India"), so neither is a cue.
 */
export function canonicalRegion(text: string): NormalizedValue<string> | null {
  const match = REGION_RE.exec(text || "");
  if (!match) return null;
  return found(STATES.regions[match[0].toLowerCase()] as string, match, text);
}
