import { parseExperienceYears } from "@badabhai/profiling-lexicon";

import { readStatedTenureYears } from "./stated-tenure";

/**
 * The 0–60 bound a form tenure figure — typed, or a stored band — must fall inside.
 *
 * THE SAME BOUND AS `EXPERIENCE_YEARS_RANGE` (`apps/api/src/profiling/parse-gates.ts`, owner ruling
 * 2026-10-14: one rule for every writer of `experience_years`). Restated here only because this
 * package cannot import `apps/api`; `form-tenure-keys.parity.test.ts` there fails the moment the
 * two disagree.
 */
export const TENURE_YEARS_RANGE = { min: 0, max: 60 } as const;

function withinTenureYearsRange(value: number): boolean {
  return (
    Number.isFinite(value) && value >= TENURE_YEARS_RANGE.min && value <= TENURE_YEARS_RANGE.max
  );
}

/**
 * Token-audit fix Q10 (decision D9) — years read out of a TYPED answer to the form's tenure
 * question, or null when there is no single, believable figure.
 *
 * WHERE IT IS USED. Only for the pack's tenure question (`turning_experience` and its siblings),
 * when the worker typed into "Koi aur — khud likhein" instead of tapping a band, and only at READ
 * time: to resolve the form's experience gates (`FORM_TYPED_TENURE_DERIVE_ENABLED`), and — #2753
 * item 2, with `FORM_TENURE_MONTHS_ENABLED` also on — as that form's years when `worker_skill` is
 * derived. The value is never stored as his answer.
 *
 * MOVED HERE UNCHANGED from `apps/api/src/profiling/form/typed-tenure.ts` (which re-exports it), so
 * the live rebuild and `db:backfill:worker-skills` read a typed answer with ONE function.
 *
 * THE SAME READERS THE CHAT USES, in the same order, so a sentence is understood the same way on
 * both roads: the shared parser first (a number WITH its unit, "10 saal", "das years"), then the
 * on-screen reader (a bare "10", or a fresher phrase meaning 0). The bare-number reading is safe
 * here for the reason `stated-tenure.ts` gives: the question on screen asks in years.
 *
 * WHAT DERIVES NOTHING (null), so the form keeps today's behaviour:
 *   - a figure the shared parser marks as negated;
 *   - TWO figures with units ("8 saal VMC, 2 saal turning"): which one answers THIS question is
 *     not ours to guess;
 *   - anything outside the same 0–60 bound the chat applies to `experience_years`;
 *   - text with no figure at all ("sep 2016 se", "6 mahine", "pata nahi").
 *
 * KNOWN, ACCEPTED: the first figure with a unit wins, so "2 saal turning, 8 VMC" reads 2 (only
 * "2 saal" carries a unit), and "ITI 2 saal ki" reads 2. The chat road already reads both this way.
 */
export function typedTenureYears(text: string): number | null {
  const first = parseExperienceYears(text);
  if (first !== null) {
    if (first.negationVetoed) return null;
    // A second figure-with-unit after the first one: ambiguous, so derive nothing.
    if (parseExperienceYears(text.slice(first.span.end)) !== null) return null;
    return withinTenureYearsRange(first.value) ? first.value : null;
  }
  const stated = readStatedTenureYears(text);
  return stated !== null && withinTenureYearsRange(stated) ? stated : null;
}
