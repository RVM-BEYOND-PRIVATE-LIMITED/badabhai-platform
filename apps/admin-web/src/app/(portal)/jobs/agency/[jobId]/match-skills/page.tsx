import { requireCapability } from "../../../../../../lib/auth";
import {
  AGENCY_JOB_CLOSED_NOTICE,
  AGENCY_JOB_NO_SKILLS,
  AGENCY_JOB_VOCABULARY_UNAVAILABLE,
} from "../../../../../../lib/agency-jobs-vocabulary";
import { AgencyPostingHeader, readAgencyPosting } from "../agency-posting-header";

import { MatchSkillForm } from "./match-skill-form";
import { readMatchVocabularyAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agency posting match skills" };

/**
 * One agency posting's Match skills tab (A6, #2576 — it was the "Agency match
 * skills" detail screen): the current ids (labels resolved from the picker
 * vocabulary, raw-mono fallback), and the editor — unless the posting is
 * closed (terminal: the API refuses writes, so no form renders) or the
 * vocabulary is unreadable (the editor is withheld, never guessed). The
 * posting's facts are its Overview tab.
 */
export default async function AgencyPostingMatchSkillsPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  await requireCapability("manage_agency_match_skills");
  const { jobId } = await params;

  // Unknown id, non-agency row, or malformed uuid: "no such posting" either
  // way. Anything else is an outage — rethrown to the error boundary.
  const job = await readAgencyPosting(jobId);

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
    <div className="page page--reading">
      <AgencyPostingHeader job={job} tab="match-skills" />

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
