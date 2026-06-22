import type { PostingSummary } from "./contracts";

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
