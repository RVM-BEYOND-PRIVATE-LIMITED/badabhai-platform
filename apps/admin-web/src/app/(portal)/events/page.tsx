import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { listEvents, type EventFilters } from "../../../lib/events";
import { EventTable } from "../../../components/event-table";
import { Pager } from "../../../components/pager";
import { PageHeader } from "../../../components/page-header";
import { EventFilterBar } from "./filter-bar";

export const dynamic = "force-dynamic";
export const metadata = { title: "Events" };

/**
 * The events viewer — filtered, keyset-paginated search over the audit spine.
 *
 * Filters live in the URL, not component state. That makes every view of this screen
 * shareable and bookmarkable, which is what an operator actually needs mid-incident:
 * "here is the exact query I was looking at" has to survive being pasted into chat.
 *
 * Pagination is the server's opaque keyset cursor. Offset paging over a table that is
 * being appended to in real time silently skips and repeats rows, which on an audit log
 * is not a cosmetic bug.
 */
export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Page-level gate. Belt and braces: the route also enforces `read_events` server-side.
  await requireCapability("read_events");

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

  const filters: EventFilters = {
    eventName: one(sp.eventName),
    actorType: one(sp.actorType),
    subjectType: one(sp.subjectType),
    correlationId: one(sp.correlationId),
    cursor: one(sp.cursor),
    limit: 50,
  };

  let page: Awaited<ReturnType<typeof listEvents>> | null = null;
  let failed = false;
  try {
    page = await listEvents(filters);
  } catch {
    // A bad filter value (e.g. a malformed correlation uuid) 400s. That is a user error,
    // not a broken portal, so it renders inline instead of tripping the error boundary.
    failed = true;
  }

  const active = Object.entries({
    eventName: filters.eventName,
    actorType: filters.actorType,
    subjectType: filters.subjectType,
    correlationId: filters.correlationId,
  }).filter(([, v]) => Boolean(v));

  // The cursor is deliberately dropped when building the "next" link's base, so paging
  // never stacks cursors and a filter change always restarts at page one. `Pager` is the
  // one implementation of that rule — this screen used to hand-roll a second copy of it.

  return (
    <div className="page">
      <PageHeader
        title="Events"
        description="The audit spine. Every important state change on the platform is recorded here."
        filters={
          <section className="panel" aria-labelledby="filters-heading">
            <h2 className="sr-only" id="filters-heading">
              Filter events
            </h2>
            <EventFilterBar
              eventName={filters.eventName ?? ""}
              actorType={filters.actorType ?? ""}
              subjectType={filters.subjectType ?? ""}
              correlationId={filters.correlationId ?? ""}
            />
          </section>
        }
      />

      <section className="panel" aria-labelledby="results-heading" aria-live="polite">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="results-heading">
              Results
            </h2>
            <p className="panel__sub">
              {failed
                ? "That filter combination was rejected."
                : `${page?.events.length ?? 0} event${page?.events.length === 1 ? "" : "s"} on this page.`}
            </p>
          </div>
          {active.length > 0 && (
            <Link className="btn btn--ghost" href="/events">
              Clear filters
            </Link>
          )}
        </div>

        {failed ? (
          <div className="state state--error">
            <h3 className="state__title">The server rejected these filters</h3>
            <p className="state__body">
              Nothing was fetched. A correlation id must be a full UUID — the short id shown
              in the table is only the first segment. Correct the value above, or clear the
              filters and start again.
            </p>
            {/* One "Clear filters" per screen: the results head carries it whenever a filter is
                set, so this state does not repeat it (owner brief 2026-10-01). */}
            {active.length > 0 ? null : (
              <div className="state__actions">
                <Link className="btn btn--ghost" href="/events">
                  Retry
                </Link>
              </div>
            )}
          </div>
        ) : (
          <EventTable
            events={page?.events ?? []}
            emptyMessage={
              active.length > 0 ? "No events match these filters" : "No events recorded yet"
            }
            /* Truthful per case: a filtered view CAN be hidden by a narrow filter; an
               unfiltered one genuinely has nothing on the spine, and telling that operator
               to "widen the filters" would send them looking for a control they have not
               used. No action here: the results head already offers "Clear filters"
               whenever there is something to clear. */
            emptyBody={
              active.length > 0
                ? "A narrow filter can hide a busy day. Widen it, or clear it to see the whole timeline."
                : "The audit spine fills as the platform is used. Events will appear here as they are emitted."
            }
          />
        )}

        <Pager
          basePath="/events"
          params={{
            eventName: filters.eventName,
            actorType: filters.actorType,
            subjectType: filters.subjectType,
            correlationId: filters.correlationId,
          }}
          nextCursor={page?.nextCursor}
          note="Paging uses a keyset cursor, so new events arriving mid-scan cannot make rows skip or repeat."
        />
      </section>
    </div>
  );
}
