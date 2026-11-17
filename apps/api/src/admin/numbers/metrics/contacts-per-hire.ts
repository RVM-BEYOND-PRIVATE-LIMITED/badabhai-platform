import { ratioCells, sumByCell, type NumbersMetricCells } from "./cells";
import {
  dayInWeek,
  inWeek,
  type NumbersDimsLookup,
  type NumbersHireRow,
  type NumbersOpenedContactRow,
  type NumbersWeekWindow,
} from "./types";

/**
 * #2755 metric group 4 — CONTACTS OPENED PER HIRE (`contacts_per_hire`), the rule of
 * `definitions.ts`: the contacts opened in the week (unlocks granted in it, the opens carried over
 * by the #2754 import left out by `excludeImportedOpens`) over the confirmed hires in the week,
 * both for countable companies, per cell. The two terms are stored; the value is the quotient in
 * hundredths, or null when the cell has no confirmed hire (not computable, never a zero).
 */
export function contactsPerHire(
  window: NumbersWeekWindow,
  opened: readonly NumbersOpenedContactRow[],
  hires: readonly NumbersHireRow[],
  companyDims: NumbersDimsLookup,
): NumbersMetricCells[] {
  return [
    ratioCells(
      "contacts_per_hire",
      sumByCell(
        opened.filter((o) => inWeek(o.grantedAt, window)),
        (o) => companyDims(o.payerId),
      ),
      sumByCell(
        hires.filter((h) => dayInWeek(h.hiredOn, window)),
        (h) => companyDims(h.payerId),
      ),
    ),
  ];
}
