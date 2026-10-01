import { eq, gte, isNull, or, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { JobShift } from "@badabhai/db";

/**
 * The worker's SHIFT and PAY-FLOOR `/feed` filters as SQL predicates (#1905).
 *
 * WHY THESE ARE FUNCTIONS OF A COLUMN. The legacy arm (`jobs`, `findOpenJobs`) is the only
 * caller today, but the postings-union arm (#1823) will serve `job_postings` through the same
 * legacy feed, and the two must agree on what "night shift" or "at least ₹20,000" means — a
 * filter that hides a job on one source and keeps its twin on the other is a worse bug than
 * no filter. So the RULE lives here once and each arm passes its own columns
 * (`jobs.shift` / `jobPostings.shift`, `jobs.payMax` / `jobPostings.payMax`).
 *
 * THE RULE IS V1's, VERBATIM. `MatchFeedRepository.listFeed`
 * (apps/api/src/match/match-feed.repository.ts, the `MATCH_V1_ENABLED` arm) already applies
 * both filters; these mirror it exactly so the deck does not change meaning when the flag flips:
 *
 *   shift    `(shift IS NULL OR shift = :shift)`          exact match on the closed enum
 *   pay_min  `(pay_max IS NULL OR pay_max >= :payMin)`    the TOP of the band, inclusive
 *
 * FILTERS ARE WIDE OR OFF (ADR-0036 Part 3). Each predicate is `undefined` — i.e. absent from
 * the WHERE — unless the worker sent that filter, and a NULL column NEVER excludes a job: an
 * unstated shift or an open-ended pay band matches every filter rather than vanishing from a
 * feed it belongs in. "Defaults that narrow are a volume leak."
 *
 * Repository-layer helpers: they build SQL and decide nothing. Whether a filter is applied is
 * the caller's input; validating that input is the DTO's and the service's job.
 */

/**
 * The SHIFT filter. `undefined` (no predicate) when the worker sent no shift.
 *
 * Exact equality, no case-folding: both sides are the same closed set — the DTO admits only
 * `day | night | rotational`, and `jobs_shift_chk` / `job_postings_shift_chk` admit only those
 * values (or NULL) on the column.
 */
export function feedShiftPredicate(
  shiftColumn: AnyPgColumn<{ data: JobShift }>,
  shift: JobShift | undefined,
): SQL | undefined {
  if (shift === undefined) return undefined;
  return or(isNull(shiftColumn), eq(shiftColumn, shift));
}

/**
 * The PAY-FLOOR filter (`pay_min` on the query string). `undefined` (no predicate) when the
 * worker sent no floor.
 *
 * Compared against the job's `pay_max` — the TOP of the band — and inclusive. A worker asking
 * for at least ₹20,000 must still see an ₹18,000–25,000 job: it CAN pay him what he asked.
 * Comparing against `pay_min` would hide most of the bands that can. A NULL `pay_max` (open-
 * ended or unstated ceiling) keeps the job, whatever its `pay_min` says — V1's rule, kept.
 *
 * `0` is a real floor (the DTO admits it) and yields a predicate; it simply excludes nothing,
 * since `pay_max` is CHECK-constrained non-negative.
 */
export function feedPayFloorPredicate(
  payMaxColumn: AnyPgColumn<{ data: number }>,
  payMin: number | undefined,
): SQL | undefined {
  if (payMin === undefined) return undefined;
  return or(isNull(payMaxColumn), gte(payMaxColumn, payMin));
}
