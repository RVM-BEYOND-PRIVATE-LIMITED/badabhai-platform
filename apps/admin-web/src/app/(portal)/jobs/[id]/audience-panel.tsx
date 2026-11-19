import Link from "next/link";
import {
  AUDIENCE_LABELS,
  type JobAudience,
  type ShownTo,
} from "../../../../lib/job-audience-vocabulary";
import { AudienceChoice } from "../audience/audience-choice";

/** The stored audience as the control's "current" choice. */
const SHOWN: Readonly<Record<JobAudience, ShownTo>> = {
  rvm_students: "campus",
  both: "both",
  badabhai_workers: "badabhai",
};

/**
 * #2958 — "Where this job shows" on the job page: the choice an admin made (or the default), the
 * RVM review, and the three-way control. Only for `manage_postings`; the page decides that.
 */
export function AudiencePanel({
  postingId,
  audience,
  reviewState,
}: {
  postingId: string;
  audience: JobAudience;
  reviewState: "pending" | "approved" | "rejected" | null;
}) {
  return (
    <section className="panel" aria-labelledby={`audience-${postingId}`}>
      <div className="panel__head">
        <div className="panel__text">
          <h2 className="panel__title" id={`audience-${postingId}`}>
            Where this job shows
          </h2>
          <p className="panel__sub">
            Set to <strong>{AUDIENCE_LABELS[audience]}</strong>
            {reviewState ? <> · RVM review {reviewState}</> : null}. A job that came from Campus
            stays hidden from BadaBhai workers until it is decided here or on the{" "}
            <Link className="table__link" href="/jobs/audience">
              where jobs show
            </Link>{" "}
            list.
          </p>
        </div>
      </div>
      <div className="panel__body">
        <AudienceChoice postingIds={[postingId]} shownTo={SHOWN[audience]} />
      </div>
    </section>
  );
}
