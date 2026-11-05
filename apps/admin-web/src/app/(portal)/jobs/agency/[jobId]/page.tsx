import { requireCapability } from "../../../../../lib/auth";
import { agencyJobStatusLabel } from "../../../../../lib/agency-jobs-vocabulary";
import { CopyId } from "../../../../../components/copy-id";
import { CustomerLink } from "../../../../../components/customer-link";
import { DetailList } from "../../../../../components/detail-list";
import { StatusPill } from "../../../../../components/status-pill";
import { Timestamp } from "../../../../../components/timestamp";
import { AgencyPostingHeader, readAgencyPosting } from "./agency-posting-header";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agency posting" };

/**
 * One agency posting — its Overview tab (A6, #2576): the facts the API serves for it. The match
 * skills it reaches workers on, and the editor, are its Match skills tab.
 *
 * Gated on `manage_agency_match_skills`, the capability every agency-job read sits on
 * (`AgencyJobsAdminController`): there is no read-only floor for these rows to fall back to.
 */
export default async function AgencyPostingPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  await requireCapability("manage_agency_match_skills");
  const { jobId } = await params;
  const job = await readAgencyPosting(jobId);
  const skills = job.match_skill_ids.length;

  return (
    <div className="page page--reading">
      <AgencyPostingHeader job={job} tab="overview" />

      <section className="panel" aria-labelledby="ap-posting">
        <h2 id="ap-posting" className="panel__title">
          Posting
        </h2>
        <DetailList
          items={[
            {
              label: "Posting id",
              value: (
                <>
                  <span className="mono">{job.job_id}</span>
                  <CopyId id={job.job_id} label="posting id" />
                </>
              ),
            },
            // Agency-owned by construction (the API reads only rows whose payer is an agent).
            { label: "Agency", value: <CustomerLink payerId={job.payer_id} payerRole="agent" /> },
            { label: "City", value: job.city },
            {
              label: "Status",
              value: <StatusPill value={job.status} label={agencyJobStatusLabel(job.status)} />,
            },
            {
              label: "Match skills",
              value: skills === 0 ? "None chosen yet" : `${skills} chosen`,
            },
            { label: "Updated", value: <Timestamp iso={job.updated_at} /> },
          ]}
        />
      </section>
    </div>
  );
}
