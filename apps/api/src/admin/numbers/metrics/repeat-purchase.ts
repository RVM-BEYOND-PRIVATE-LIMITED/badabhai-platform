import {
  NUMBERS_REPEAT_WINDOWS_DAYS,
  repeatPurchaseMetricId,
  type NumbersRepeatWindowDays,
} from "../definitions";
import { cellGrid, cellKey, hundredths, sumByCell, type NumbersMetricCells } from "./cells";
import {
  inWeek,
  type NumbersDimsLookup,
  type NumbersPaidOrderRow,
  type NumbersWeekWindow,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The instant a cohort week's `days` window has elapsed for EVERY company of the cohort: `days`
 * days after the week ends (the latest first payment a cohort can hold is the week's last
 * instant). Pure.
 */
export function repeatWindowClosesAt(window: NumbersWeekWindow, days: number): Date {
  return new Date(window.toUtcExclusive.getTime() + days * DAY_MS);
}

/** Has the window closed by `asOf`? Before then the window is PENDING. */
export function repeatWindowComplete(window: NumbersWeekWindow, days: number, asOf: Date): boolean {
  return asOf.getTime() >= repeatWindowClosesAt(window, days).getTime();
}

/** One cohort company: its first payment and the gap to its second, if it has one. */
export interface NumbersCohortCompany {
  readonly payerId: string;
  readonly firstAt: Date;
  /** Milliseconds from the first paid order's settle time to the second's; null with only one. */
  readonly gapMs: number | null;
}

/**
 * The COHORT of a week: every company whose FIRST paid order (over every order it ever paid, as
 * `orders` holds them) settled inside the week, with the gap to its second paid order. `orders`
 * must hold every countable paid order settled before the week's end plus the longest window
 * (`NumbersWeekSources.cohortOrders`), so each company's first and second are in it. Two orders
 * settled at the same instant are a first and a second 0 ms apart.
 */
export function cohortOf(
  window: NumbersWeekWindow,
  orders: readonly NumbersPaidOrderRow[],
): NumbersCohortCompany[] {
  const times = new Map<string, number[]>();
  for (const o of orders) {
    const list = times.get(o.payerId);
    if (list === undefined) times.set(o.payerId, [o.settledAt.getTime()]);
    else list.push(o.settledAt.getTime());
  }
  const cohort: NumbersCohortCompany[] = [];
  for (const [payerId, list] of times) {
    list.sort((a, b) => a - b);
    const first = list[0]!;
    if (!inWeek(new Date(first), window)) continue;
    const second = list[1];
    cohort.push({
      payerId,
      firstAt: new Date(first),
      gapMs: second === undefined ? null : second - first,
    });
  }
  return cohort.sort((a, b) => a.payerId.localeCompare(b.payerId));
}

/** Did the company pay again within `days` days of its first payment? */
export function paidAgainWithin(company: NumbersCohortCompany, days: number): boolean {
  return company.gapMs !== null && company.gapMs <= days * DAY_MS;
}

/**
 * #2755 item 7, metric group 1 — REPEAT BUYING (`repeat_purchase_30d` / `_60d` / `_90d`), the rule
 * of `definitions.ts`, stored under the COHORT week.
 *
 * Per cell (the company's latest posting's city and trade): the DENOMINATOR is the cohort's size,
 * the NUMERATOR the cohort companies with a second paid order within the window, and the value the
 * share in hundredths (rounded half up; null for an empty cohort). A window that has not closed by
 * `asOf` for every company of the cohort is PENDING: value AND numerator null, the denominator kept
 * (the cohort's size is final once the week has ended), never a partial share. The source is
 * `payment_orders` with status paid, already reduced to countable companies. Pure.
 */
export function repeatPurchase(
  window: NumbersWeekWindow,
  orders: readonly NumbersPaidOrderRow[],
  companyDims: NumbersDimsLookup,
  asOf: Date,
): NumbersMetricCells[] {
  const cohort = cohortOf(window, orders);
  const dims = (c: NumbersCohortCompany) => companyDims(c.payerId);
  const denominators = sumByCell(cohort, dims);
  return NUMBERS_REPEAT_WINDOWS_DAYS.map((days: NumbersRepeatWindowDays) => {
    const complete = repeatWindowComplete(window, days, asOf);
    const numerators = sumByCell(
      cohort.filter((c) => paidAgainWithin(c, days)),
      dims,
    );
    return {
      metric: repeatPurchaseMetricId(days),
      cells: cellGrid().map(({ cityGroup, tradeGroup }) => {
        const key = cellKey(cityGroup, tradeGroup);
        const denominator = denominators.get(key) ?? 0;
        if (!complete) {
          return {
            cityGroup,
            tradeGroup,
            value: null,
            numerator: null,
            denominator,
            suppressed: false,
          };
        }
        const numerator = numerators.get(key) ?? 0;
        return {
          cityGroup,
          tradeGroup,
          value: denominator === 0 ? null : hundredths(numerator, denominator),
          numerator,
          denominator,
          suppressed: false,
        };
      }),
    };
  });
}

/**
 * Is a stored cohort cell PENDING? Pending is stored as a value and a numerator that are both null
 * on a cell that is not suppressed (a company figure never is); a closed window always stores its
 * numerator (0 for an empty cohort). Only meaningful for a cohort metric.
 */
export function isPendingCohortCell(cell: {
  readonly value: number | null;
  readonly numerator: number | null;
  readonly suppressed: boolean;
}): boolean {
  return !cell.suppressed && cell.value === null && cell.numerator === null;
}
