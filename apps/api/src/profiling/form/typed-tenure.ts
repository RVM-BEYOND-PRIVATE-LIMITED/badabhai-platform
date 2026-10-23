import { parseExperienceYears } from "@badabhai/profiling-lexicon";

import { withinFieldBound } from "../answer-capture";
import { readStatedTenureYears } from "../stated-tenure";

/**
 * Token-audit fix Q10 (decision D9) — years read out of a TYPED answer to the form's tenure
 * question, or null when there is no single, believable figure.
 *
 * WHERE IT IS USED. Only for the pack's tenure question (`turning_experience` and its siblings),
 * when the worker typed into "Koi aur — khud likhein" instead of tapping a band, and only at READ
 * time to resolve the experience gates. The value is never stored as his answer.
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
    return withinFieldBound("experience_years", first.value) ? first.value : null;
  }
  const stated = readStatedTenureYears(text);
  return stated !== null && withinFieldBound("experience_years", stated) ? stated : null;
}
