import { Badge } from "../../../../components/ds";
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
 *
 * UI-1: the surface is the shared `.table` primitive, wrapped in `.tablewrap` (which is the
 * scroll box, so a wide table scrolls inside itself and the page never scrolls sideways). The
 * caller frames it in a `.panel--table`. The handle is a `.mono` DATA cell rather than the
 * previous `<th scope="row">`: `.table th` is the primitive's COLUMN-header treatment (sticky,
 * uppercase, sunken), which a row header would wrongly inherit — see the report note.
 */
export function WorkerActivityList({ workers }: { workers: AgencyWorker[] }) {
  if (workers.length === 0) {
    return (
      <div className="state">
        <span className="state__icon">
          <i className="ph ph-users-three" aria-hidden="true" />
        </span>
        <h3 className="state__title">No workers to show yet</h3>
        <p className="state__body">
          A worker appears here only after two things happen: they join BadaBhai through your
          invite, <strong>and</strong> they agree to share their activity with you. That second
          step is a separate consent we ask the worker for in their own app — it is not switched
          on yet, so this list will stay empty for now. Nothing is broken, and there is nothing
          to retry.
        </p>
        <p className="state__body">
          Keep sharing your invite link in the meantime: referrals are recorded from the moment
          a worker joins, so they will be here waiting once sharing is switched on and a worker
          agrees. Workers who decline are simply absent — we never tell you who chose not to
          share.
        </p>
      </div>
    );
  }

  return (
    <div className="tablewrap">
      <table className="table">
        <caption className="sr-only">
          Workers you referred who agreed to share their activity: a private handle, whether
          their profile is complete, how many times they applied, how many times a company
          unlocked them, and the last day they were active.
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
              <td className="mono">{w.ref}</td>
              <td>
                <Badge tone={w.profileComplete ? "success" : "neutral"} upper>
                  {w.profileComplete ? "Complete" : "In progress"}
                </Badge>
              </td>
              <td className="num">{w.appliedCount}</td>
              <td className="num">{w.unlockedCount}</td>
              {/* Coarse UTC day as sent, or an honest "not seen" — never a fabricated date.
                  The fallback is TEXT, so it drops the mono-tabular treatment. */}
              <td className={w.lastActiveOn ? "mono" : undefined}>
                {w.lastActiveOn ?? "Not seen yet"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
