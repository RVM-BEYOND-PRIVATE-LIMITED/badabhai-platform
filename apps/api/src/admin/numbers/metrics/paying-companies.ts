import { distinctCountCells, type NumbersMetricCells } from "./cells";
import {
  byWeekEnd,
  inWeek,
  type NumbersDimsLookup,
  type NumbersPaidOrderRow,
  type NumbersWeekWindow,
} from "./types";

/**
 * #2755 metric group 1 — COMPANIES THAT PAID (`paying_companies`) and COMPANIES THAT HAVE EVER PAID
 * (`paying_companies_cumulative`), the rules of `definitions.ts`.
 *
 * The source is `payment_orders` with status paid (the mock purchase route writes no order row, so
 * no mock purchase can reach here; never `credit_ledger.price_inr` or `payment.captured`), already
 * reduced to countable companies. A company is counted ONCE however many orders it paid, in the
 * cell of its latest posting's city and trade.
 */
export function payingCompanies(
  window: NumbersWeekWindow,
  orders: readonly NumbersPaidOrderRow[],
  companyDims: NumbersDimsLookup,
): NumbersMetricCells[] {
  const dims = (o: NumbersPaidOrderRow) => companyDims(o.payerId);
  const key = (o: NumbersPaidOrderRow) => o.payerId;
  return [
    distinctCountCells(
      "paying_companies",
      orders.filter((o) => inWeek(o.settledAt, window)),
      key,
      dims,
    ),
    distinctCountCells(
      "paying_companies_cumulative",
      orders.filter((o) => byWeekEnd(o.settledAt, window)),
      key,
      dims,
    ),
  ];
}
