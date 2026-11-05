import { requireCapability } from "../../../../lib/auth";
import { listAgencyJobs, type AgencyJobMatchSkills } from "../../../../lib/agency-jobs";
import { agencyJobStatusLabel, AGENCY_JOBS_EMPTY } from "../../../../lib/agency-jobs-vocabulary";
import { CustomerLink } from "../../../../components/customer-link";
import { PageHeader } from "../../../../components/page-header";
import { StatusPill } from "../../../../components/status-pill";
import { RetryActions } from "../../../../components/retry-actions";
import { formatRelative, shortId, timestampTitle } from "../../../../lib/format";
import { CopyId } from "../../../../components/copy-id";
import { DataGrid, type GridColumn } from "../../../../components/data-grid";
import { AGENCY_POSTINGS_HREF, agencyPostingHref } from "../../../../lib/agency-posting-href";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agency postings" };

/**
 * The agency postings on the data grid (A4, #2574); a row opens the posting (its Overview tab —
 * the match-skill editor is its Match skills tab, A6 #2576).
 */
const COLUMNS: readonly GridColumn<AgencyJobMatchSkills>[] = [
  {
    id: "job",
    header: "Job",
    cell: (job) => job.title,
    trail: (job) => (
      <div className="table__meta mono">
        <span title={job.job_id}>{shortId(job.job_id)}</span>
        <CopyId id={job.job_id} label="posting id" />
      </div>
    ),
    title: (job) => job.title,
  },
  /* Agency-owned by construction (the API inner-joins payers.role = 'agent'), so the persona is
     stated. */
  {
    id: "agency",
    header: "Agency",
    width: "customer",
    cell: (job) => <CustomerLink payerId={job.payer_id} payerRole="agent" />,
  },
  { id: "city", header: "City", width: "short", text: "truncate", cell: (job) => job.city, title: (job) => job.city },
  {
    id: "status",
    header: "Status",
    width: "status",
    cell: (job) => <StatusPill value={job.status} label={agencyJobStatusLabel(job.status)} />,
  },
  { id: "skills", header: "Skills", width: "number", cell: (job) => job.match_skill_ids.length },
  {
    id: "updated",
    header: "Updated",
    width: "date",
    cell: (job) => (
      <time dateTime={job.updated_at} title={timestampTitle(job.updated_at)}>
        {formatRelative(job.updated_at)}
      </time>
    ),
  },
];

/**
 * Agency postings — every agency posting with the `match_skill_ids` it matches on (#2192). It
 * was the "Agency match skills" section; since A6 (#2576) it is a view of Postings, opened from
 * the Postings header, and each row opens the posting, whose Match skills tab holds the editor.
 * An agency posting is a `jobs` row, not a `job_postings` one, so it has its own list and its
 * own page rather than a row on `/jobs`. Newest first, one bounded page (the API serves no
 * cursor).
 *
 * Reads sit on the dedicated `manage_agency_match_skills` grant — the same gate the posting's
 * page and the write require.
 */
export default async function AgencyPostingsPage() {
  await requireCapability("manage_agency_match_skills");

  let jobs: Awaited<ReturnType<typeof listAgencyJobs>> | null = null;
  let failed = false;
  try {
    jobs = await listAgencyJobs();
  } catch {
    // Rendered inline below — an outage is not a 500.
    failed = true;
  }

  return (
    <div className="page page--list">
      <PageHeader
        back={{ href: "/jobs", label: "Postings" }}
        title="Agency postings"
        description="Agency postings and the match skills each one matches on."
      />

      <section className="panel" aria-live="polite">
        {failed || jobs === null ? (
          // No cursor on this bounded list: explicit undefined (admins page
          // precedent) so the recovery renders Retry alone.
          <RetryActions href={AGENCY_POSTINGS_HREF} cursor={undefined} />
        ) : jobs.length === 0 ? (
          <p className="empty">{AGENCY_JOBS_EMPTY}</p>
        ) : (
          <DataGrid
            id="agency-jobs"
            caption="Agency postings and their match skills, newest first"
            columns={COLUMNS}
            rows={jobs}
            rowKey={(job) => job.job_id}
            rowLink={{
              column: "job",
              href: (job) => agencyPostingHref(job.job_id),
              name: (job) => job.title,
            }}
          />
        )}
      </section>
    </div>
  );
}
