import Link from "next/link";
import type { AdminActionOutcome } from "../lib/admin-action-result";

/** Where a success sends the operator to see the audit event it wrote, and what that is called. */
export interface ResultEventsLink {
  href: string;
  /**
   * "View event timeline" for ONE record's timeline; "View all admin actions" for the admin
   * directory, whose actions have no per-admin timeline and land on the filtered /events.
   */
  label: string;
}

/** One record's event timeline as a result link, or none when the reader may not open it. */
export function timelineLink(href: string | null): ResultEventsLink | null {
  return href ? { href, label: "View event timeline" } : null;
}

/**
 * Every governed admin action on the audit spine — the ONE way the admin directory links into
 * the log, under one name: the page header, the invite result and every row action's result.
 * Each of those emits an `admin.action_performed`; there is no per-admin slice to offer instead
 * (`admin_session` has no timeline route, and `/events?subjectType=admin_session` is every
 * admin's sessions, not the action just taken).
 */
export const ALL_ADMIN_ACTIONS_LINK: ResultEventsLink = {
  href: "/events?eventName=admin.action_performed",
  label: "View all admin actions",
};

/**
 * The post-action result banner (Step 3 of the admin write-action plan).
 *
 * `changed: false` is a SUCCESSFUL no-op (e.g. "already suspended") and renders with the same
 * neutral/success tone as `changed: true` — only `ok: false` gets the danger treatment. A
 * success links to where the resulting audit event can be read — when the reader may read
 * events at all. `eventsLink` is null for a session without `read_events`: the page it would
 * open redirects them away, so it is not offered (an affordance, never the gate).
 *
 * Reuses the existing `.alert` primitive (`apps/admin-web/src/app/globals.css`) rather than
 * inventing a banner of its own — the same block already used for the admins page's
 * (now-removed) read-only notice and the events/jobs/companies empty-state guidance.
 */
export function AdminActionResultBanner({
  outcome,
  eventsLink,
}: {
  outcome: AdminActionOutcome;
  eventsLink: ResultEventsLink | null;
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
      {eventsLink ? (
        <div className="alert__actions">
          <Link className="btn btn--ghost btn--sm" href={eventsLink.href}>
            {eventsLink.label}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
