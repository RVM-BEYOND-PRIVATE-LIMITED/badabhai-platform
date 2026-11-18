import { distinctCountCells, type NumbersMetricCells } from "./cells";
import {
  byWeekEnd,
  inWeek,
  type NumbersDimsLookup,
  type NumbersFirstPublicationRow,
  type NumbersWeekWindow,
} from "./types";

/**
 * #2755 metric group 2 — COMPANIES THAT POSTED THEIR FIRST JOB (`companies_posted`) and COMPANIES
 * THAT HAVE EVER POSTED (`companies_posted_cumulative`), the rules of `definitions.ts`.
 *
 * The source is each countable company's FIRST `job_postings.published_at` (test and sample
 * companies and the seed's sample postings left out in SQL). Owner question 3 default: a company
 * has posted when its job is first published, so a company counts in exactly one week.
 */
export function companiesPosted(
  window: NumbersWeekWindow,
  firstPublications: readonly NumbersFirstPublicationRow[],
  companyDims: NumbersDimsLookup,
): NumbersMetricCells[] {
  const dims = (r: NumbersFirstPublicationRow) => companyDims(r.payerId);
  const key = (r: NumbersFirstPublicationRow) => r.payerId;
  return [
    distinctCountCells(
      "companies_posted",
      firstPublications.filter((r) => inWeek(r.firstPublishedAt, window)),
      key,
      dims,
    ),
    distinctCountCells(
      "companies_posted_cumulative",
      firstPublications.filter((r) => byWeekEnd(r.firstPublishedAt, window)),
      key,
      dims,
    ),
  ];
}
