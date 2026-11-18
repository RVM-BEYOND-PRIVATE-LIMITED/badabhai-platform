import { sumByCell, valueCells, type NumbersMetricCells } from "./cells";
import {
  dayInWeek,
  type NumbersDimsLookup,
  type NumbersHireRow,
  type NumbersWeekWindow,
} from "./types";

/**
 * #2755 metric group 4 — CONFIRMED HIRES (`confirmed_hires`, in the week) and their total
 * (`confirmed_hires_cumulative`), the rules of `definitions.ts`.
 *
 * The source is `hires` with status `confirmed` only (#2753 part H: a `reported` or `rejected`
 * record never counts), test and sample companies and test-account and sample workers left out in
 * SQL. A hire is a record, not a company: two hires by one company are two. The week is the
 * record's `hired_on`, the India day of its first confirming source.
 */
export function confirmedHires(
  window: NumbersWeekWindow,
  hires: readonly NumbersHireRow[],
  companyDims: NumbersDimsLookup,
): NumbersMetricCells[] {
  const dims = (h: NumbersHireRow) => companyDims(h.payerId);
  return [
    valueCells(
      "confirmed_hires",
      sumByCell(
        hires.filter((h) => dayInWeek(h.hiredOn, window)),
        dims,
      ),
    ),
    valueCells(
      "confirmed_hires_cumulative",
      sumByCell(
        hires.filter((h) => h.hiredOn <= window.sunday),
        dims,
      ),
    ),
  ];
}
