/**
 * The closed set of promotion criteria.
 *
 * Extracted from `promote-skills.ts` for one reason: `promotion-holds.ts` has to validate that
 * a hold names a REAL criterion, and importing that check from the runner would make the two
 * modules mutually dependent at runtime. The dependency now points one way —
 * `promote-skills` -> `promotion-holds` -> `promotion-criteria` — and the runner re-exports
 * both symbols, so every existing `from "./promote-skills"` import is unchanged.
 *
 * THE SET IS CLOSED BY DECISION, not by accident. A new promotion rule belongs inside an
 * existing criterion's detail, or behind a batch-level tripwire (see the match-vocabulary and
 * hold-register tripwires) — NOT as a new member here. `promote-skills.test.ts` pins the list
 * verbatim so growing it is a deliberate, reviewed act.
 */
export const CRITERIA = [
  "GATE_ACCEPTED",
  "IS_PROVISIONAL",
  "ACTIVE_EDGE",
  "FULLY_EMBEDDED",
  "EVAL_COVERED",
  "RESOLVABLE_ABOVE_FLOOR",
  "NO_REGRESSION",
] as const;

export type Criterion = (typeof CRITERIA)[number];

export function isCriterion(v: string): v is Criterion {
  return (CRITERIA as readonly string[]).includes(v);
}
