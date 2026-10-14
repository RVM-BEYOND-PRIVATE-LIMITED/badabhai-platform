import { notFound } from "next/navigation";
import { requireCapability } from "../../../../lib/auth";
import { isAdminRequestError } from "../../../../lib/admin-http";
import { getAgencyJobMatchSkills } from "../../../../lib/agency-jobs";
import {
  agencyJobStatusLabel,
  AGENCY_JOB_CLOSED_NOTICE,
  AGENCY_JOB_NO_SKILLS,
  AGENCY_JOB_VOCABULARY_UNAVAILABLE,
} from "../../../../lib/agency-jobs-vocabulary";
import { CustomerLink } from "../../../../components/customer-link";
import { DetailList } from "../../../../components/detail-list";
import { PageHeader } from "../../../../components/page-header";
import { StatusPill } from "../../../../components/status-pill";
import { formatTimestamp } from "../../../../lib/format";
import { MatchSkillForm } from "./match-skill-form";
import { readMatchVocabularyAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agency posting" };

/**
 * One agency posting's match-skill selection: the current ids (labels resolved
 * from the picker vocabulary, raw-mono fallback), and the editor — unless the
 * posting is closed (terminal: the API refuses writes, so no form renders) or
 * the vocabulary is unreadable (the editor is withheld, never guessed).
 */
export default async function AgencyJobDetailPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  await requireCapability("manage_agency_match_skills");
  const { jobId } = await params;

  let job: Awaited<ReturnType<typeof getAgencyJobMatchSkills>>;
  try {
    job = await getAgencyJobMatchSkills(jobId);
  } catch (err) {
    // Unknown id, non-agency row, or malformed uuid: "no such posting" either
    // way. Anything else is an outage — rethrown to the error boundary.
    if (isAdminRequestError(err) && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }

  // Degrades to null (never throws): a vocabulary outage — or an older
  // backend before #2207 — withholds the editor but must not take down the
  // accurate current selection below it.
  const vocabulary = await readMatchVocabularyAction().then((r) =>
    r.ok ? r.vocabulary : null,
  );

  const closed = job.status === "closed";
  const labelOf = (id: string): string | null =>
    vocabulary?.skills.find((s) => s.skill_id === id)?.label ?? null;

  return (
    <div className="page">
      <PageHeader
        back={{ href: "/agency-jobs", label: "Agency match skills" }}
        title={job.title}
        description={`Agency posting · ${job.city}`}
      />

      <section className="panel" aria-labelledby="aj-detail">
        <h2 id="aj-detail" className="panel__title">
          Posting
        </h2>
        <DetailList
          items={[
            { label: "Job", value: <span className="mono">{job.job_id}</span> },
            {
              label: "Agency",
              value: <CustomerLink payerId={job.payer_id} payerRole="agent" />,
            },
            { label: "City", value: job.city },
            {
              label: "Status",
              value: <StatusPill value={job.status} label={agencyJobStatusLabel(job.status)} />,
            },
            { label: "Updated", value: <time dateTime={job.updated_at}>{formatTimestamp(job.updated_at)}</time> },
          ]}
        />
      </section>

      <section className="panel" aria-labelledby="aj-skills">
        <h2 id="aj-skills" className="panel__title">
          Match skills ({job.match_skill_ids.length})
        </h2>
        {job.match_skill_ids.length === 0 ? (
          <p className="empty">{AGENCY_JOB_NO_SKILLS}</p>
        ) : (
          <ul className="chiplist">
            {job.match_skill_ids.map((id) => (
              <li className="chip" key={id}>
                {labelOf(id) ?? <span className="mono">{id}</span>}
                {labelOf(id) ? <span className="table__meta mono"> {id}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="aj-edit">
        <h2 id="aj-edit" className="panel__title">
          Change selection
        </h2>
        {closed ? (
          <p className="alert__body" role="note">
            {AGENCY_JOB_CLOSED_NOTICE}
          </p>
        ) : vocabulary === null ? (
          <p className="alert__body" role="note">
            {AGENCY_JOB_VOCABULARY_UNAVAILABLE}
          </p>
        ) : (
          <MatchSkillForm jobId={job.job_id} current={job.match_skill_ids} vocabulary={vocabulary} />
        )}
      </section>
    </div>
  );
}
