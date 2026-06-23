import type { AgencyJob, PostingSummary } from "./contracts";

/**
 * Pure, PII-FREE derivations for the agency DEMAND dashboard.
 *
 * The agency surface is faceless: these helpers operate on opaque posting rows and
 * produce COUNTS only — no name/phone/raw data ever enters or leaves. Jobs are
 * OPEN / CLOSED / PAUSED / DRAFT only (HARD LOCK: no hire-outcome / interview /
 * selected / hired stage — those are product-locked out of scope).
 */

/** The only posting lifecycle states (mirrors the contract enum). */
export const JOB_STATUSES = ["draft", "open", "closed", "paused"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** A faceless job-status breakdown for the demand summary panel. */
export interface JobStatusSummary {
  total: number;
  open: number;
  closed: number;
  paused: number;
  draft: number;
}

/**
 * Count postings by lifecycle status. Counts only — no posting content is read
 * beyond `status`, and there is no PII anywhere in a `PostingSummary`.
 */
export function summarizeJobStatuses(postings: readonly PostingSummary[]): JobStatusSummary {
  const summary: JobStatusSummary = { total: 0, open: 0, closed: 0, paused: 0, draft: 0 };
  for (const p of postings) {
    summary.total += 1;
    summary[p.status] += 1;
  }
  return summary;
}

/**
 * A faceless demand breakdown for the AGENCY's OWN `jobs.payer_id` vacancies (LIVE,
 * ADR-0022). Agency jobs are `open|closed` ONLY (Phase-1 `JobStatus`; pause == close).
 * Counts + a summed applicant count only — every field on an `AgencyJob` is coarse/
 * non-PII (trade enum, labels, bands, counts), so nothing identifying enters or leaves.
 */
export interface AgencyDemandSummary {
  total: number;
  open: number;
  closed: number;
  /** Total applicants received across all of the agency's own jobs (a count). */
  applicantsReceived: number;
}

/** Count the agency's OWN jobs by status (open|closed) + sum applicants. Counts only. */
export function summarizeAgencyJobs(jobs: readonly AgencyJob[]): AgencyDemandSummary {
  const summary: AgencyDemandSummary = { total: 0, open: 0, closed: 0, applicantsReceived: 0 };
  for (const j of jobs) {
    summary.total += 1;
    summary[j.status] += 1;
    summary.applicantsReceived += j.applicantsReceived;
  }
  return summary;
}
