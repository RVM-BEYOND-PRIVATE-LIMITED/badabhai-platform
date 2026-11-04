import { notFound } from "next/navigation";
import { isAdminRequestError } from "../../../../../lib/admin-http";
import { getAgencyJobMatchSkills, type AgencyJobMatchSkills } from "../../../../../lib/agency-jobs";
import {
  AGENCY_POSTINGS_HREF,
  agencyPostingHref,
  type AgencyPostingTab,
} from "../../../../../lib/agency-posting-href";
import { FilterChip } from "../../../../../components/filter-chip-link";
import { PageHeader } from "../../../../../components/page-header";

/**
 * ONE AGENCY POSTING, TWO TABS (A6, #2576): Overview and Match skills. "Agency match skills" was a
 * section of its own; it is now a tab on the posting it edits. Both tabs render this header —
 * the back link to Agency postings, the posting's title, one sentence — and the tab row under it.
 *
 * The tab row is the console's segmented chip control (the Skill discovery tiers' pattern): the
 * current tab is text, the other a link carrying the navigation pending cue.
 */
export function AgencyPostingHeader({
  job,
  tab,
}: {
  job: AgencyJobMatchSkills;
  tab: AgencyPostingTab;
}) {
  return (
    <>
      <PageHeader
        back={{ href: AGENCY_POSTINGS_HREF, label: "Agency postings" }}
        title={job.title}
        description={`Agency posting · ${job.city}`}
      />
      <div className="segmented" role="group" aria-label="Agency posting">
        <FilterChip
          selected={tab === "overview"}
          href={agencyPostingHref(job.job_id)}
          cursor={undefined}
        >
          Overview
        </FilterChip>
        <FilterChip
          selected={tab === "match-skills"}
          href={agencyPostingHref(job.job_id, "match-skills")}
          cursor={undefined}
        >
          Match skills
        </FilterChip>
      </div>
    </>
  );
}

/**
 * The posting both tabs read. Unknown id, a non-agency row or a malformed uuid is "no such
 * posting" (the API answers 404 / 400 alike); anything else is an outage for the error boundary.
 */
export async function readAgencyPosting(jobId: string): Promise<AgencyJobMatchSkills> {
  try {
    return await getAgencyJobMatchSkills(jobId);
  } catch (err) {
    if (isAdminRequestError(err) && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }
}
