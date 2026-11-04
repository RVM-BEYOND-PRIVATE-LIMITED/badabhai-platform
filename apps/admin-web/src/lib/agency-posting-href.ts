/**
 * Where an agency posting lives in the console (A6, #2576).
 *
 * An agency posting is a `jobs` row, NOT a `job_postings` one: `GET /admin/job-postings/:id`
 * answers 404 for its id, and the only admin read of it is
 * `GET /admin/agency-jobs/:jobId/match-skills` (`manage_agency_match_skills`). So it cannot be a
 * row of Postings (`/jobs`) or a tab of a posting's page there; it has its own list and its own
 * page, filed under Postings:
 *
 *   /jobs/agency                          every agency posting (was /agency-jobs)
 *   /jobs/agency/<jobId>                  the posting — its Overview tab
 *   /jobs/agency/<jobId>/match-skills     its Match skills tab (was /agency-jobs/<jobId>)
 *
 * The one place these addresses are built, so the list, the posting's tabs and the quick jump
 * cannot disagree. A job id is kept inside its one path segment.
 */
export const AGENCY_POSTINGS_HREF = "/jobs/agency";

/** The agency posting's two tabs. */
export type AgencyPostingTab = "overview" | "match-skills";

export function agencyPostingHref(jobId: string, tab: AgencyPostingTab = "overview"): string {
  const posting = `${AGENCY_POSTINGS_HREF}/${encodeURIComponent(jobId)}`;
  return tab === "overview" ? posting : `${posting}/match-skills`;
}
