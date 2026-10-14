import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { listAgencyJobs } from "../../../lib/agency-jobs";
import { agencyJobStatusLabel, AGENCY_JOBS_EMPTY } from "../../../lib/agency-jobs-vocabulary";
import { CustomerLink } from "../../../components/customer-link";
import { PageHeader } from "../../../components/page-header";
import { StatusPill } from "../../../components/status-pill";
import { RetryActions } from "../../../components/retry-actions";
import { formatRelative, shortId } from "../../../lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agency match skills" };

/**
 * Agency-job match skills — every agency posting with the `match_skill_ids`
 * it matches on. Entry point for #2192: a row leads to its detail/edit
 * screen. Newest first, one bounded page (the API serves no cursor).
 *
 * Reads sit on the dedicated `manage_agency_match_skills` grant — the same
 * gate the detail screen and the write require.
 */
export default async function AgencyJobsPage() {
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
    <div className="page">
      <PageHeader
        title="Agency match skills"
        description="Agency postings and the match skills each one matches on — open a row to review or change its selection."
      />

      <section className="panel" aria-live="polite">
        {failed || jobs === null ? (
          // No cursor on this bounded list: explicit undefined (admins page
          // precedent) so the recovery renders Retry alone.
          <RetryActions href="/agency-jobs" cursor={undefined} />
        ) : jobs.length === 0 ? (
          <p className="empty">{AGENCY_JOBS_EMPTY}</p>
        ) : (
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Agency</th>
                  <th>City</th>
                  <th>Status</th>
                  <th>Skills</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.job_id}>
                    <td>
                      <Link
                        className="link"
                        href={`/agency-jobs/${encodeURIComponent(job.job_id)}`}
                        title={job.job_id}
                      >
                        {job.title}
                      </Link>
                      <div className="table__meta mono">{shortId(job.job_id)}</div>
                    </td>
                    {/* Agency-owned by construction (the API inner-joins
                        payers.role = 'agent'), so the persona is stated. */}
                    <td>
                      <CustomerLink payerId={job.payer_id} payerRole="agent" />
                    </td>
                    <td>{job.city}</td>
                    <td>
                      <StatusPill value={job.status} label={agencyJobStatusLabel(job.status)} />
                    </td>
                    <td>{job.match_skill_ids.length}</td>
                    <td>
                      <time dateTime={job.updated_at}>{formatRelative(job.updated_at)}</time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
