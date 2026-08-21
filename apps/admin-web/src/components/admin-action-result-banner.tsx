import Link from "next/link";
import type { AdminActionOutcome } from "../lib/admin-action-result";

/**
 * The post-action result banner (Step 3 of the admin write-action plan).
 *
 * `changed: false` is a SUCCESSFUL no-op (e.g. "already suspended") and renders with the same
 * neutral/success tone as `changed: true` — only `ok: false` gets the danger treatment. Every
 * success links to the entity's event timeline so the operator can see the resulting audit
 * event immediately, without leaving the page.
 *
 * Reuses the existing `.alert` primitive (`apps/admin-web/src/app/globals.css`) rather than
 * inventing a banner of its own — the same block already used for the admins page's
 * (now-removed) read-only notice and the events/jobs/companies empty-state guidance.
 */
export function AdminActionResultBanner({
  outcome,
  timelineHref,
}: {
  outcome: AdminActionOutcome;
  timelineHref: string;
}) {
  if (!outcome.ok) {
    return (
      <div className="alert alert--danger" role="alert">
        <div className="alert__text">
          <p className="alert__title">Action failed</p>
          <p className="alert__body">{outcome.error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`alert ${outcome.changed ? "alert--success" : "alert--info"}`} role="status">
      <div className="alert__text">
        <p className="alert__title">{outcome.changed ? "Done" : "No change"}</p>
        <p className="alert__body">{outcome.message}</p>
      </div>
      <div className="alert__actions">
        <Link className="btn btn--ghost btn--sm" href={timelineHref}>
          View in event timeline
        </Link>
      </div>
    </div>
  );
}
