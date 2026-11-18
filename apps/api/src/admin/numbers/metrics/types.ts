import { weekEndDayOf, weekRange } from "../week";
import type { NumbersDims } from "./cells";

/**
 * #2755 part B — what every metric function is handed: the week, and the SOURCE ROWS the
 * repository read for it (`numbers-weekly.repository.ts`), already reduced to the rows the
 * exclusions keep (test, sample and linked rows are left out in SQL, by `exclusions.ts`). A metric
 * function is pure over these: it picks the rows its rule names, places each entity in its city ×
 * trade cell and counts. The unit tests feed it rows by hand; the parity DB test proves the rows
 * the repository reads are the rows the hand-written SQL counts.
 */

/** One week, in every form a rule needs it. */
export interface NumbersWeekWindow {
  /** The Monday that names the week. */
  readonly week: string;
  /** The Sunday it ends on (`yyyy-mm-dd`, India time). */
  readonly sunday: string;
  /** Monday 00:00 IST, as a UTC instant. */
  readonly fromUtc: Date;
  /** The next Monday 00:00 IST: query `>= fromUtc AND < toUtcExclusive`. */
  readonly toUtcExclusive: Date;
}

/** The window of `week` (a Monday), from `week.ts`'s one week rule. */
export function weekWindow(week: string): NumbersWeekWindow {
  const { fromUtc, toUtcExclusive } = weekRange(week);
  return { week, sunday: weekEndDayOf(week), fromUtc, toUtcExclusive };
}

/** Is the instant inside the week? */
export function inWeek(at: Date, window: NumbersWeekWindow): boolean {
  const t = at.getTime();
  return t >= window.fromUtc.getTime() && t < window.toUtcExclusive.getTime();
}

/** Is the instant before the week's end (the week itself included)? */
export function byWeekEnd(at: Date, window: NumbersWeekWindow): boolean {
  return at.getTime() < window.toUtcExclusive.getTime();
}

/** Is the India day (`yyyy-mm-dd`) inside the week? */
export function dayInWeek(day: string, window: NumbersWeekWindow): boolean {
  return day >= window.week && day <= window.sunday;
}

/** Where a company or a worker sits; an id the lookup does not know is `unknown × unknown`. */
export type NumbersDimsLookup = (id: string) => NumbersDims;

// -----------------------------------------------------------------------------------------------
// Source rows (the repository's output)
// -----------------------------------------------------------------------------------------------

/** A paid order of a countable company, settled before the week's end. */
export interface NumbersPaidOrderRow {
  readonly payerId: string;
  /**
   * The pack bought. Nullable since #2749 part 3 (a product other than a credit pack carries none;
   * a credit-pack order always does, `payment_orders_pack_code_chk`): none reads as `other`.
   */
  readonly packCode: string | null;
  /** Whole rupees, as `payment_orders.amount_inr` stores it. */
  readonly amountInr: number;
  /** `updated_at` at the move to paid. */
  readonly settledAt: Date;
}

/** A countable company's FIRST publish (sample postings left out). */
export interface NumbersFirstPublicationRow {
  readonly payerId: string;
  readonly firstPublishedAt: Date;
}

/** A countable worker's CURRENT profile (`CURRENT_PROFILE_ORDER`). */
export interface NumbersCurrentProfileRow {
  readonly workerId: string;
  readonly status: string;
  readonly confirmedAt: Date | null;
}

/**
 * A countable worker who may have been active in the week's 30-day window, with the two terms of
 * #2753's last-active day AS OF THE WEEK'S SUNDAY: his newest `worker_activity` day on or before
 * it, and his newest device sighting before the week's end.
 */
export interface NumbersActivityRow {
  readonly workerId: string;
  readonly activeOn: string | null;
  readonly lastSeenAt: Date | null;
}

/** A confirmed hire of a countable company and worker. */
export interface NumbersHireRow {
  readonly payerId: string;
  /** The India day of the first confirming source. */
  readonly hiredOn: string;
}

/** A contact a countable company opened (an unlock granted), with its grant time. */
export interface NumbersOpenedContactRow {
  readonly payerId: string;
  readonly grantedAt: Date;
}

/** A countable worker's first trade-form completion, and whether his current profile is confirmed. */
export interface NumbersFormCompletionRow {
  readonly workerId: string;
  readonly firstCompletedAt: Date;
  readonly profileConfirmed: boolean;
}

/**
 * #2750 / #2755 metric group 6 — one countable company's welcome lot that RAN OUT: the moment its
 * spends reached the lot's size, and the first real paid order the company settled after that
 * moment (null when none yet). A welcome lot never refilled (returns are new lots), so it runs
 * out once at most.
 */
export interface NumbersWelcomeRunOutRow {
  readonly payerId: string;
  readonly ranOutAt: Date;
  readonly firstPaidAfter: Date | null;
}

/** #2750 / #2755 metric group 7 — one couldn't-reach case of a countable company. */
export interface NumbersReachCaseRow {
  readonly payerId: string;
  readonly reportedAt: Date;
  /** Null while the case is open. */
  readonly resolvedAt: Date | null;
  /** Credits the close gave back (0 unless not reached). */
  readonly creditsReturned: number;
}

/** #2750 / #2755 metric group 8 — one open a placement-team waiver paid for (its `waived` line). */
export interface NumbersWaivedOpenRow {
  readonly payerId: string;
  readonly at: Date;
}
