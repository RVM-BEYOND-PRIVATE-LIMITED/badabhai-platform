import { sumByCell, valueCells, type NumbersMetricCells } from "./cells";
import {
  inWeek,
  type NumbersDimsLookup,
  type NumbersReachCaseRow,
  type NumbersWaivedOpenRow,
  type NumbersWeekWindow,
  type NumbersWelcomeRunOutRow,
} from "./types";

/**
 * #2755 metric group 6 — WELCOME CREDITS (#2750 item 4), the rules of `definitions.ts`:
 *  - `welcome_credits_used_up`: companies whose welcome lot ran out (its spends reached its size)
 *    in the week. A lot that expired unspent did not run out.
 *  - `welcome_then_bought`: of those companies, the ones with a real paid order settled after the
 *    run-out and by the week's end.
 * Test and sample companies are left out in SQL; one welcome lot per company, so a row is a company.
 */
export function welcomeCredits(
  window: NumbersWeekWindow,
  rows: readonly NumbersWelcomeRunOutRow[],
  companyDims: NumbersDimsLookup,
): NumbersMetricCells[] {
  const dims = (r: NumbersWelcomeRunOutRow) => companyDims(r.payerId);
  const ranOut = rows.filter((r) => inWeek(r.ranOutAt, window));
  const bought = ranOut.filter(
    (r) =>
      r.firstPaidAfter !== null &&
      r.firstPaidAfter.getTime() < window.toUtcExclusive.getTime(),
  );
  return [
    valueCells("welcome_credits_used_up", sumByCell(ranOut, dims)),
    valueCells("welcome_then_bought", sumByCell(bought, dims)),
  ];
}

/**
 * #2755 metric group 7 — COULDN'T-REACH CLAIMS (#2750 items 7 and 8):
 *  - `couldnt_reach_claims`: cases reported in the week;
 *  - `couldnt_reach_credits_returned`: the credits returned by cases closed in the week (a case
 *    closed not reached by the desk or at its deadline; reached ones return none).
 */
export function couldntReach(
  window: NumbersWeekWindow,
  cases: readonly NumbersReachCaseRow[],
  companyDims: NumbersDimsLookup,
): NumbersMetricCells[] {
  const dims = (c: NumbersReachCaseRow) => companyDims(c.payerId);
  return [
    valueCells(
      "couldnt_reach_claims",
      sumByCell(
        cases.filter((c) => inWeek(c.reportedAt, window)),
        dims,
      ),
    ),
    valueCells(
      "couldnt_reach_credits_returned",
      sumByCell(
        cases.filter((c) => c.resolvedAt !== null && inWeek(c.resolvedAt, window)),
        dims,
        (c) => c.creditsReturned,
      ),
    ),
  ];
}

/**
 * #2755 metric group 8 — CREDITS WAIVED by the placement team (#2750 item 5): the opens a waiver paid
 * for in the week, one credit each. A waiver frees only an RVM applicant, whose open costs the
 * brief's standard one credit; the ledger's `waived` line records the open, not a price.
 */
export function creditsWaived(
  window: NumbersWeekWindow,
  opens: readonly NumbersWaivedOpenRow[],
  companyDims: NumbersDimsLookup,
): NumbersMetricCells[] {
  return [
    valueCells(
      "credits_waived",
      sumByCell(
        opens.filter((o) => inWeek(o.at, window)),
        (o) => companyDims(o.payerId),
      ),
    ),
  ];
}
