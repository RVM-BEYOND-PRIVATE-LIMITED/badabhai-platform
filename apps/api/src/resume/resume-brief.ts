import { GENERAL_FORM_BRIEF_MAX_CHARS } from "@badabhai/types";

import { knownNamePattern } from "../common/redact-known-name";
import { looksLikeMoney, readStoredBrief } from "../profiling/general-form/general-form-brief";
import { cleanScalar } from "./resume-clean";
import { knownYearsPhrase } from "./resume-sheet-rows";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════
 * THE BRIEF UNDER THE HEADLINE (ADR-0045 R6, §4.3) — the general road's one line of prose.
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * R6: the worker's own words, PII-screened, on BOTH the worker and the employer copy; if he skips
 * it, a fixed deterministic line; otherwise nothing. NO MODEL WRITES THE BRIEF — not the own line,
 * not the fallback, not a polish of either. This file is the two halves of that ruling that run at
 * RENDER time: may the worker's stored line still print ({@link vetOwnBrief}), and if not, what is
 * the fixed line ({@link composeFallbackBrief}).
 *
 * PURE. No I/O, no clock, no logger — a brief is worker text, and nothing here may ever be the
 * place it reaches a log line. A caller that wants to observe the outcome has a boolean.
 */

/** The most skills the fallback line names (§4.3: "the first three headline skills"). */
export const FALLBACK_BRIEF_MAX_SKILLS = 3;

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE RENDER-TIME RE-CHECK OF THE WORKER'S OWN LINE
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * MAY THIS STORED BRIEF STILL PRINT? — the render-time re-check, decided ONCE per render and
 * BEFORE the mapper, by both callers (the worker's render and the employer disclosure).
 *
 * WHY THE WRITE-TIME SCREEN IS NOT ENOUGH. `screenBrief` ran when the worker saved the line, against
 * the name he held THEN and the walls that existed THEN. The stored row outlives both: he can
 * change his name afterwards (`workers.service.ts`), and a brief saved before the money wall
 * (owner ruling 2026-09-27) never faced it. The employer copy renders LIVE from the stored row, so
 * whatever is true of the row today is what a payer reads today.
 *
 * FOUR CHECKS, THE ONES THAT CAN HAVE CHANGED OR THAT GUARD THE PAYER COPY:
 *   - it passes `cleanScalar` UNCHANGED — no surrounding whitespace, no email or 7+ digit run
 *     (the résumé's own read-path screen for every worker-typed scalar);
 *   - at most `GENERAL_FORM_BRIEF_MAX_CHARS` code points (the write bound; a longer row was not
 *     written by the form);
 *   - no MONEY shape — the write wall's own predicate, `looksLikeMoney`, so the render can never
 *     pass a figure the write would refuse;
 *   - not the worker's CURRENT name — the whole name or any 3+ character token, matched exactly as
 *     `redactKnownName` matches it (`knownNamePattern`, read with `.search`, which ignores the
 *     pattern's global `lastIndex`).
 *
 * `knownName` IS THE DECRYPTED NAME, OR NULL WHEN NONE IS STORED. A caller that could not DECRYPT
 * a stored name must not call this with null — it must treat the brief as unusable, because a
 * name check that did not run is not a name check that passed (fail closed; the write side refuses
 * the same case as `brief_unscreenable`).
 *
 * A FAILED CHECK NEVER PRINTS NOTHING: the caller's `false` makes the mapper print the fixed
 * fallback line, on BOTH copies (owner ruling 2026-09-27 — the copies always agree).
 */
export function vetOwnBrief(text: string, knownName: string | null): boolean {
  try {
    if (cleanScalar(text) !== text) return false;
    if ([...text].length > GENERAL_FORM_BRIEF_MAX_CHARS) return false;
    if (looksLikeMoney(text)) return false;
    const name = knownNamePattern(knownName?.normalize("NFKC"));
    return name === null || text.search(name) === -1;
  } catch {
    // A check that did not finish is not a check that passed.
    return false;
  }
}

/**
 * The stored `profile_brief` attribute, read through the form's own narrower, and vetted: true
 * only for an ANSWERED brief that passes {@link vetOwnBrief}. A declined brief, a missing row and
 * a damaged row are all false — and all three print the fallback line, which is R6's "if the
 * worker skips it".
 */
export function ownBriefUsable(storedBrief: unknown, knownName: string | null): boolean {
  const brief = readStoredBrief(storedBrief);
  return brief?.status === "answered" && vetOwnBrief(brief.text, knownName);
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE FIXED FALLBACK LINE
// ─────────────────────────────────────────────────────────────────────────────────────────

/** The settled facts the fallback line is composed from — every one already printed on the page. */
export interface FallbackBriefFacts {
  /**
   * The headline's role — the ONE cased value the Verdict Line, `canonicalRole` and the profile
   * headline print. Null means no subject, and a line about nobody is not a line: null.
   */
  readonly role: string | null;
  /** The dated-employment total (R5), or null — no job stored, or any job undated. */
  readonly years: number | null;
  /** No employment is stored AND the employment read succeeded — the road's one Fresher rule. */
  readonly fresher: boolean;
  /**
   * FALSE WHEN THE EMPLOYMENT READ FAILED. Then nothing about his history is known — not his years,
   * not whether he is a fresher, not whether his jobs are dated — so no sentence applies and the
   * answer is null (ADR-0045 §4.3's grammar, unwidened: "{R} with skills in {S}." is licensed only
   * for jobs that exist and are undated, never for jobs nobody could read).
   */
  readonly employmentsReadable: boolean;
  /** The printed Skills list, in its printed order. */
  readonly skills: readonly string[];
}

/**
 * THE FALLBACK LINE (ADR-0045 §4.3) — a closed grammar over facts already on the page. The first
 * sentence that applies:
 *
 *   years known, skills               {R} with {Y} of experience in {S}.
 *   years known, no skills            {R} with {Y} of experience.
 *   fresher, skills                   Fresher {R} with skills in {S}.
 *   jobs exist but some undated,
 *   skills                            {R} with skills in {S}.
 *   anything else                     null
 *
 * {Y} is the total AS THE HEADLINE WRITES IT (`knownYearsPhrase` — "4 yrs 2 mo"), so the line
 * cannot spell the headline's figure another way. {S} is the first three printed skills, joined
 * "A, B and C" / "A and B" / "A".
 *
 * AT MOST `GENERAL_FORM_BRIEF_MAX_CHARS` CODE POINTS, the bound the worker's own line has — the
 * slot and the line model are sized for it. Skills are dropped FROM THE END until the sentence
 * fits; a with-skills sentence left with no skill falls to the next sentence that applies (only
 * the years pair has one), and a line that cannot fit at all is null. Never truncated mid-word:
 * a clipped line would be a sentence nobody composed.
 *
 * NO WORD HERE IS FREE. "with", "of experience in", "Fresher" and "with skills in" are the grammar;
 * every other token is a value the sheet already prints. The fabrication gate re-derives each
 * sentence from the fixture rather than calling this function, so a drift here fails the gate.
 */
export function composeFallbackBrief(facts: FallbackBriefFacts): string | null {
  const role = facts.role?.trim();
  if (!role || !facts.employmentsReadable) return null;
  const skills = facts.skills
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, FALLBACK_BRIEF_MAX_SKILLS);
  const years = knownYearsPhrase(facts.years);
  if (years !== null) {
    return (
      withFittingSkills(skills, (s) => `${role} with ${years} of experience in ${s}.`) ??
      fitting(`${role} with ${years} of experience.`)
    );
  }
  if (facts.fresher)
    return withFittingSkills(skills, (s) => `Fresher ${role} with skills in ${s}.`);
  return withFittingSkills(skills, (s) => `${role} with skills in ${s}.`);
}

/**
 * The sentence with as many of `skills` as fit — all of them first, then one fewer from the END,
 * down to one — or null when even one does not fit, or there are none.
 */
function withFittingSkills(
  skills: readonly string[],
  sentence: (joined: string) => string,
): string | null {
  for (let count = skills.length; count > 0; count -= 1) {
    const text = fitting(sentence(joinSkills(skills.slice(0, count))));
    if (text !== null) return text;
  }
  return null;
}

/** "A, B and C" / "A and B" / "A". */
function joinSkills(skills: readonly string[]): string {
  if (skills.length <= 1) return skills.join("");
  return `${skills.slice(0, -1).join(", ")} and ${skills[skills.length - 1]}`;
}

/** The text if it fits the brief's bound, in code points — the measure the write side uses. */
function fitting(text: string): string | null {
  return [...text].length <= GENERAL_FORM_BRIEF_MAX_CHARS ? text : null;
}
