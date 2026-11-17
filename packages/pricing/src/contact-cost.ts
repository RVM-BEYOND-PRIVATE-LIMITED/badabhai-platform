import type { CreditRules } from "./credit-rules";

/**
 * #2750 item 2 — THE COST RULE: how many credits opening one worker's contact costs a company
 * (brief 4C.5, section 7; register B2-37 to B2-41, B4C-10, B6-04).
 *
 * ONE pure function, used by BOTH the quote (`POST /payer/unlocks/quotes`, the number on the
 * button) and the debit (the open itself), so the cost on the button is the credits debited.
 *
 * | Who is opened                                                     | Credits              |
 * | ----------------------------------------------------------------- | -------------------- |
 * | A contact the company already opened                              | 0                    |
 * | A contact on the company's paid Managed Hiring order (#2751)      | 0                    |
 * | An RVM student, waived by the placement team (#2750 item 5)       | 0                    |
 * | An RVM student                                                    | standard (1)         |
 * | A higher-priced rung with `higherCostMinMonths` or more in it     | higher (2)           |
 * | Anyone else: operators, freshers, under the line, unknown         | standard (1)         |
 *
 * NEVER PRICE UP ON MISSING DATA. The caller resolves {@link ContactCostFacts.higherRungMonths}
 * from the worker's stated rungs and his experience in that trade; when either is unknown it is
 * null, and null is the standard cost.
 *
 * FACTS ALREADY ON THE CARD ONLY. Nothing here may depend on consent, a limit, deletion state or
 * anything else a company cannot already see, or the price becomes a way to probe those (#2750
 * private notes item 5). Applied or found by search: the same cost.
 *
 * Pure, PII-free, no LLM (CLAUDE.md invariant 4).
 */
export interface ContactCostFacts {
  /** The company already holds an open contact for him (re-opening is free). */
  readonly alreadyOpened: boolean;
  /** He is on a paid Managed Hiring order's tracker for this company (#2751; false until then). */
  readonly managedHiringOrder: boolean;
  /** The placement team waived the cost for this company or job (#2750 item 5; false until then). */
  readonly waived: boolean;
  /** He is an actively linked RVM student. */
  readonly rvmStudent: boolean;
  /**
   * The most months of experience he has in a trade where his rung prices Higher, or null when
   * no rung prices Higher or the months are unknown.
   */
  readonly higherRungMonths: number | null;
}

/** Why a contact costs what it costs. Stored nowhere a company can read it; for logs and tests. */
export type ContactCostBasis =
  | "already_opened"
  | "managed_hiring"
  | "waived"
  | "rvm_student"
  | "higher"
  | "standard";

export interface ContactCost {
  readonly credits: number;
  readonly basis: ContactCostBasis;
}

export function contactCost(rules: CreditRules, facts: ContactCostFacts): ContactCost {
  if (facts.alreadyOpened) return { credits: 0, basis: "already_opened" };
  if (facts.managedHiringOrder) return { credits: 0, basis: "managed_hiring" };
  if (facts.rvmStudent) {
    return facts.waived
      ? { credits: 0, basis: "waived" }
      : { credits: rules.standardCost, basis: "rvm_student" };
  }
  const months = facts.higherRungMonths;
  if (months !== null && Number.isFinite(months) && months >= rules.higherCostMinMonths) {
    return { credits: rules.higherCost, basis: "higher" };
  }
  return { credits: rules.standardCost, basis: "standard" };
}
