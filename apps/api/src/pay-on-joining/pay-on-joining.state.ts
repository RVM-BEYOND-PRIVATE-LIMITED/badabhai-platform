import type { PojPaymentState } from "@badabhai/event-schema";

/** The columns a hire's payment state is read from. */
export interface PojPaymentFacts {
  factoryPaidOn: string | null;
  partnerPayerId: string | null;
  partnerSharePaise: number;
  partnerPaidOn: string | null;
}

/**
 * #2753 item 11 — where a hire's money stands, DERIVED from the dates the admin recorded:
 *
 *   - `awaiting_factory` — the factory has not paid;
 *   - `partner_due`      — the factory has paid, a partner is owed a share above zero, and has not
 *                          been paid yet (the pilot pays the partner when the factory pays);
 *   - `settled`          — the factory has paid and nobody is owed anything more.
 *
 * A REPORT, NOT A RULE: nothing is refused or triggered by it. Its SQL twin is
 * `PayOnJoiningHiresRepository.paymentStateIs`, which the list's `paid` filter uses.
 */
export function paymentStateOf(facts: PojPaymentFacts): PojPaymentState {
  if (facts.factoryPaidOn === null) return "awaiting_factory";
  if (
    facts.partnerPayerId !== null &&
    facts.partnerSharePaise > 0 &&
    facts.partnerPaidOn === null
  ) {
    return "partner_due";
  }
  return "settled";
}
