import Link from "next/link";
import { getEntityTimeline, type AdminTimelineSubjectType } from "../lib/events";
import { EventTable } from "./event-table";
import { Pager } from "./pager";

/** `job_posting` → `job posting`. Only the whitelist's `_`-joined codes need this. */
function subjectTypeLabel(type: AdminTimelineSubjectType): string {
  return type.replace(/_/g, " ");
}

/**
 * The per-entity event timeline — every event recorded for ONE worker, payer or job
 * posting, keyset-paginated. This is the screen the "View event timeline" links on the
 * worker/company/agency/job detail pages actually mean: `/admin/entities/:type/:id/timeline`,
 * not the generic `/admin/events` filter (which has no `subjectId` filter at all).
 *
 * A Server Component, like the screens it is composed from: it fetches and renders in one
 * pass, reusing `EventTable`/`Pager` rather than a second table implementation.
 */
export async function EntityTimeline({
  type,
  id,
  cursor,
  basePath,
  backHref,
  backLabel,
}: {
  type: AdminTimelineSubjectType;
  id: string;
  /** The current page's keyset cursor, read from `searchParams` by the caller. */
  cursor?: string;
  /** This timeline route's own path — where `Pager`'s "Next page" link points. */
  basePath: string;
  /** Where the eyebrow link returns to — the entity's own detail page. */
  backHref: string;
  backLabel: string;
}) {
  let page: Awaited<ReturnType<typeof getEntityTimeline>> | null = null;
  let failed = false;
  try {
    page = await getEntityTimeline(type, id, { cursor, limit: 50 });
  } catch {
    failed = true;
  }

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <p className="page__eyebrow">
            <Link className="link" href={backHref}>
              {backLabel}
            </Link>
          </p>
          <h1 className="page__title">Event timeline</h1>
          <p className="page__sub">
            Every event recorded for this {subjectTypeLabel(type)}, newest first.
          </p>
        </div>
      </header>

      <section className="panel" aria-labelledby="timeline-results" aria-live="polite">
        <div className="panel__head">
          <h2 className="panel__title" id="timeline-results">
            Events
          </h2>
          <p className="panel__sub">
            {failed
              ? "The timeline could not be loaded."
              : `${page?.events.length ?? 0} event${page?.events.length === 1 ? "" : "s"} on this page.`}
          </p>
        </div>

        {failed ? (
          <div className="state state--error">
            <h3 className="state__title">The event timeline is unavailable</h3>
            <p className="state__body">
              The events read failed. The {subjectTypeLabel(type)} record itself came from a
              separate read and is unaffected. Reload this page to try again.
            </p>
            <div className="state__actions">
              <Link className="btn btn--ghost" href={basePath}>
                Reload
              </Link>
            </div>
          </div>
        ) : (
          <EventTable
            events={page?.events ?? []}
            emptyMessage="No events recorded yet"
            emptyBody={`The audit spine fills as this ${subjectTypeLabel(type)} is used. Events will appear here as they are emitted.`}
          />
        )}

        <Pager
          basePath={basePath}
          params={{}}
          nextCursor={page?.nextCursor}
          note="Paging uses a keyset cursor, so new events arriving mid-scan cannot make rows skip or repeat."
        />
      </section>
    </div>
  );
}
