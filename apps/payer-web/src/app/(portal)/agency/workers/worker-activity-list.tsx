import { Badge, Card } from "../../../../components/ds";
import type { AgencyWorker } from "../../../../lib/contracts";

/**
 * The referred-worker ENGAGEMENT table (ADR-0022 agency portal, B5) — presentational only.
 *
 * FACELESS (CLAUDE.md §2 #2): a row is an opaque per-agency handle, a profile boolean, two
 * counts, and a coarse UTC day. There is deliberately NO link, no drill-down, no tooltip and
 * no derived label on `ref` — it is a pseudonym, and anything that let an agency pivot from it
 * to a person would be the first brick of a de-anonymisation surface. The backend does not
 * send a name/phone/employer/job/unlocker, and nothing here reconstructs one.
 *
 * DATES ARE RENDERED VERBATIM. `lastActiveOn` is already the coarse UTC day the backend
 * formatted in SQL (`YYYY-MM-DD`) precisely so no client can shift it; re-parsing it into a
 * locale string on an IST browser would render the PREVIOUS day. `null` renders as an honest
 * "Not seen yet" — never today's date, never a fabricated "recently".
 *
 * EMPTY IS THE NORMAL STATE, not a failure: the backend lists only workers carrying an active
 * `agent_activity_visibility` consent, and no client asks for that consent yet, so this list
 * is empty in production today. The empty copy says exactly that, without implying the feature
 * is broken and without promising data soon.
 */
export function WorkerActivityList({ workers }: { workers: AgencyWorker[] }) {
  if (workers.length === 0) {
    return (
      <Card variant="flat" className="agency-workers__empty">
        <h3 className="agency-workers__empty-title">No workers to show yet</h3>
        <p className="agency-workers__empty-note">
          A worker appears here only after two things happen: they join BadaBhai through your
          invite, <strong>and</strong> they agree to share their activity with you. That second
          step is a separate consent we ask the worker for in their own app — it is not switched
          on yet, so this list will stay empty for now. Nothing is broken, and there is nothing
          to retry.
        </p>
        <p className="agency-workers__empty-note">
          Keep sharing your invite link in the meantime: referrals are recorded from the moment
          a worker joins, so they will be here waiting once sharing is switched on and a worker
          agrees. Workers who decline are simply absent — we never tell you who chose not to
          share.
        </p>
      </Card>
    );
  }

  return (
    <table className="agency-workers__table">
      <caption className="sr-only">
        Workers you referred who agreed to share their activity: a private handle, whether their
        profile is complete, how many times they applied, how many times a company unlocked
        them, and the last day they were active.
      </caption>
      <thead>
        <tr>
          <th scope="col">Worker</th>
          <th scope="col">Profile</th>
          <th scope="col">Applied</th>
          <th scope="col">Unlocked</th>
          <th scope="col">Last active</th>
        </tr>
      </thead>
      <tbody>
        {workers.map((w) => (
          <tr key={w.ref}>
            {/* The per-agency pseudonym — mono tabular, and NEVER a link. */}
            <th scope="row" className="agency-workers__ref bb-mono">
              {w.ref}
            </th>
            <td>
              <Badge tone={w.profileComplete ? "success" : "neutral"} upper>
                {w.profileComplete ? "Complete" : "In progress"}
              </Badge>
            </td>
            <td className="agency-workers__metric bb-mono">{w.appliedCount}</td>
            <td className="agency-workers__metric bb-mono">{w.unlockedCount}</td>
            <td
              className={
                w.lastActiveOn
                  ? "agency-workers__last bb-mono"
                  : "agency-workers__last"
              }
            >
              {/* Coarse UTC day as sent, or an honest "not seen" — never a fabricated date. */}
              {w.lastActiveOn ?? "Not seen yet"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
