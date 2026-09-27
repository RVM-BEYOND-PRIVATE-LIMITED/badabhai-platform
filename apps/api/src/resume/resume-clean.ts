import { looksLikePii } from "@badabhai/validators";

/**
 * THE RÉSUMÉ'S READ-PATH SCREENS for worker-supplied text — one list rule and one scalar rule.
 *
 * A LEAF MODULE, and that is its whole reason to exist apart from `resume-render-input.ts`, where
 * both functions were written. Three readers now need the same rule: the mapper (every list and
 * label it prints), the general road's profile build (`general-road-profile.ts`, which screens the
 * stamp's skills and labels with THIS rule before they are written — one rule on the way in and
 * the way out), and the general road's brief re-check (`resume-brief.ts`, ADR-0045 Phase 5). The
 * last one is imported BY the mapper, so leaving the screens inside the mapper would have made the
 * brief module and the mapper import each other. Moved verbatim; the behaviour is unchanged.
 */

/** Trimmed entries with the blanks removed — see the note at the mapper's `skills` call site. */
export function cleanList(items: readonly string[]): string[] {
  return items.map((s) => s.trim()).filter((s) => s.length > 0 && !looksLikePii(s));
}

/**
 * A stored container's scalar, or null when it looks like raw PII (#831).
 *
 * THE BACKSTOP, NOT THE GATE. The gate is `_certified_scalar` in the ai-service, which runs
 * every one of these fields through the pseudonymizer before the container is ever persisted.
 * This exists because that gate protects FUTURE extractions and nothing else: rows written
 * before it landed hold values no gateway ever vouched for, they are rendered from storage on
 * every download, and `fromResumeProfile` feeds BOTH the worker's PDF and the employer-facing
 * masked disclosure. A read-path check is the only thing those rows will ever see.
 *
 * `looksLikePii` DELIBERATELY, and not the stricter `looksLikeActionContextPii`. The strict one
 * also rejects 2-4 title-cased words, which is the exact shape of "New Delhi", "Night Shift"
 * and most legitimate role labels — it would blank real résumé fields, and a blanked résumé is
 * the failure #824 already cost us once. `looksLikePii` matches only email shapes and 7+ digit
 * runs, neither of which any honest value of these fields contains.
 *
 * NULL RATHER THAN A MASK, matching the ai-service: absence is a shape every template already
 * handles, and "[PHONE]" printed under `Shift` would be worse than the line not being there.
 */
export function cleanScalar(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed || looksLikePii(trimmed)) return null;
  return trimmed;
}
