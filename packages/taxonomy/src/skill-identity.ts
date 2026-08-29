/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PHRASE → CANONICAL SKILL ID. The reverse index the taxonomy never had (R16 §3).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY IT EXISTS. A worker's résumé prints his skills from two arrays that nothing joins:
 * `DraftProfile.skills` holds canonical ids and `DraftProfile.skill_labels` holds the raw
 * phrases he actually said. `mergeSkillsWithLabels` de-duped them by comparing STRINGS — so
 * "Fixture / job setup" (the canonical label) and "fixture setup" (his phrase) survived as two
 * separate chips, and the sheet listed one skill twice.
 *
 * MEASURED, AND IT IS NOT A FUTURE PROBLEM. The two label tables drifted long ago: the Python
 * lexicon writes `fixture setup` / `program editing` / `drawing reading` / `CAM software` while
 * `SKILL_CORPUS.labelEn` says `Fixture / job setup` / `Program editing (G & M codes)` /
 * `Drawing reading (GD&T / technical drawing)` / `CAM software (Mastercam/Fusion/etc.)`. Four of
 * the five ids the deterministic detector can emit double-render TODAY, with
 * `SKILL_CANONICALIZE_ENABLED` off. The alias layer would add a fifth path to the same bug, not
 * create it.
 *
 * DE-DUPE ON IDENTITY, NOT ON SPELLING. Two spellings of one skill are one skill. A string
 * comparison can only ever catch the cases where the two sources happen to agree — which is
 * exactly the cases that were never broken. This is the same move `invariant-in-the-key` names:
 * put the invariant somewhere the code cannot route around, not in a normalisation that has to
 * keep guessing.
 *
 * WHAT IT IS NOT. It is not a matcher and must never become one. It resolves a phrase ONLY when
 * that phrase is a reviewed alias or a canonical label — an exact, normalised lookup over
 * ratified data. It never scores, never guesses a nearest neighbour, and returns null the moment
 * it is unsure, because the caller's fallback (keep the worker's phrase) is the safe answer and a
 * wrong id here would silently delete a real skill from a man's résumé.
 */

import { SKILL_CORPUS } from "./skill-corpus";
import { WEDGE_ALIASES } from "./wedge-aliases";

/**
 * The comparison key.
 *
 * IDENTICAL TO `mergeSkillsWithLabels`' own normalisation, deliberately: lowercase, every
 * non-alphanumeric run collapsed to one space, trimmed. Two normalisations that are ALMOST the
 * same is how a de-dupe starts disagreeing with the index it consults — a phrase would resolve
 * here and then not match there. Devanagari collapses to empty under this rule, which is why
 * `skillIdForPhrase` falls back to a raw-text index below.
 */
function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Latin-normalised phrase → skill id. */
const BY_NORM = new Map<string, string>();
/** Lowercased raw text → skill id, so a Devanagari or fully non-Latin alias still resolves. */
const BY_RAW = new Map<string, string>();

function remember(text: string, skillId: string): void {
  const raw = text.trim().toLowerCase();
  if (raw.length > 0 && !BY_RAW.has(raw)) BY_RAW.set(raw, skillId);
  const key = norm(text);
  // FIRST WRITER WINS, and collisions are left alone rather than resolved. If two skills claim
  // one phrase the honest answer is "ambiguous", and the caller's fallback — keep the worker's
  // own words — is better than picking one. `skillIdForPhrase` is only ever used to DROP a
  // duplicate, so a missed resolution costs a duplicate chip and a wrong one costs a skill.
  if (key.length > 0 && !BY_NORM.has(key)) BY_NORM.set(key, skillId);
}

for (const seed of SKILL_CORPUS) {
  remember(seed.labelEn, seed.skillId);
  if (seed.labelHi) remember(seed.labelHi, seed.skillId);
  for (const alias of seed.aliases) remember(alias.text, seed.skillId);
}
// The RVM-ratified vernacular. These are the moat §8.2 names — the terms a worker actually says
// that no model produces from the English label — so they are exactly the phrases most likely to
// arrive as raw text beside their own canonical id.
for (const proposal of WEDGE_ALIASES) {
  if (proposal.ratified) remember(proposal.alias.text, proposal.skillId);
}

/**
 * The canonical skill id this phrase names, or null when nothing reviewed says.
 *
 * An id passed in returns itself, so a caller may hand this a mixed list without pre-sorting it.
 */
export function skillIdForPhrase(phrase: string): string | null {
  const raw = phrase.trim().toLowerCase();
  if (raw.length === 0) return null;
  if (BY_RAW.has(raw)) return BY_RAW.get(raw)!;
  const key = norm(phrase);
  if (key.length === 0) return null;
  return BY_NORM.get(key) ?? null;
}

/** How many phrases resolve. Exported so a test can prove the index is not empty. */
export function skillIdentityIndexSize(): number {
  return BY_NORM.size + BY_RAW.size;
}
