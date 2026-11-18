import { ratioCells, sumByCell, type NumbersMetricCells } from "./cells";
import {
  inWeek,
  type NumbersDimsLookup,
  type NumbersPostingChoiceRow,
  type NumbersWeekWindow,
} from "./types";

/**
 * #2755 metric group 5 — THE POSTING SCREEN (#2751 items 1 to 3), the rules of `definitions.ts`:
 * of the taps on the two posting buttons in the week, the share on "Post free"
 * (`posting_choice_free_share`) and on "Post free + Starter" (`posting_choice_starter_share`), in
 * hundredths rounded half up; null in a cell with no tap (never a zero share of nothing). The
 * numerator and the denominator are kept. One tap per posting (the table's key).
 */
export function postingChoiceShares(
  window: NumbersWeekWindow,
  taps: readonly NumbersPostingChoiceRow[],
  companyDims: NumbersDimsLookup,
): NumbersMetricCells[] {
  const dims = (t: NumbersPostingChoiceRow) => companyDims(t.payerId);
  const week = taps.filter((t) => inWeek(t.recordedAt, window));
  const all = sumByCell(week, dims);
  return [
    ratioCells(
      "posting_choice_free_share",
      sumByCell(
        week.filter((t) => t.choice === "free"),
        dims,
      ),
      all,
    ),
    ratioCells(
      "posting_choice_starter_share",
      sumByCell(
        week.filter((t) => t.choice === "free_plus_pack"),
        dims,
      ),
      all,
    ),
  ];
}
