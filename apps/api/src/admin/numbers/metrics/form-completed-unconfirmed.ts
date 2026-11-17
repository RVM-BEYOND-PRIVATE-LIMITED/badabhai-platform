import { cellGrid, cellKey, sumByCell, suppressSmallCells, type NumbersMetricCells } from "./cells";
import {
  inWeek,
  type NumbersDimsLookup,
  type NumbersFormCompletionRow,
  type NumbersWeekWindow,
} from "./types";

/**
 * #2755 part B — THE FORM-WORKER GAP, a DIAGNOSTIC (`form_completed_unconfirmed`), not a headline.
 *
 * Part A found that a trade-form worker reaches the funnel's `profile_confirmed` only through the
 * app's résumé step: nothing on the server confirms a profile when a form is completed, so a form
 * worker who leaves before that step is never a "completed profile" although his answers are saved.
 * This measures the size of that gap per week: the countable workers whose FIRST
 * `profile.form_completed` is in the week (the numerator: the ones whose current profile is still
 * not confirmed when the week is computed; the denominator: all of them). The value is the
 * numerator. Worker figure: a cell under the floor keeps no number, the total never.
 */
export function formCompletedUnconfirmed(
  window: NumbersWeekWindow,
  completions: readonly NumbersFormCompletionRow[],
  workerDims: NumbersDimsLookup,
): NumbersMetricCells[] {
  const firstSeen = new Map<string, NumbersFormCompletionRow>();
  for (const c of completions) {
    if (!inWeek(c.firstCompletedAt, window) || firstSeen.has(c.workerId)) continue;
    firstSeen.set(c.workerId, c);
  }
  const finished = [...firstSeen.values()];
  const dims = (c: NumbersFormCompletionRow) => workerDims(c.workerId);
  const all = sumByCell(finished, dims);
  const unconfirmed = sumByCell(
    finished.filter((c) => !c.profileConfirmed),
    dims,
  );
  return [
    suppressSmallCells({
      metric: "form_completed_unconfirmed",
      cells: cellGrid().map(({ cityGroup, tradeGroup }) => {
        const key = cellKey(cityGroup, tradeGroup);
        const numerator = unconfirmed.get(key) ?? 0;
        return {
          cityGroup,
          tradeGroup,
          value: numerator,
          numerator,
          denominator: all.get(key) ?? 0,
          suppressed: false,
        };
      }),
    }),
  ];
}
