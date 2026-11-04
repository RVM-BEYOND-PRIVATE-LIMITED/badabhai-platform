import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { listEvents, listRecentEventNames, type EventFilters } from "../../../lib/events";
import { withinBudget } from "../../../lib/within-budget";
import {
  isMalformedUuid,
  isOverLength,
  readRefusal,
  type ReadRefusal,
} from "../../../lib/read-refusal";
import { EVENT_FILTER_MAX_LENGTH } from "../../../lib/list-filter-values";
import { isCalendarDay, istDayEnd, istDayStart } from "../../../lib/ist-day";
import { queryHref } from "../../../lib/query-href";
import { EventTable } from "../../../components/event-table";
import { Pager } from "../../../components/pager";
import { PageHeader } from "../../../components/page-header";
import { EventFilterBar } from "./filter-bar";
import { FilterPanel } from "../../../components/filter-panel";
import { NavPendingCue } from "../../../components/nav-pending";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import {
  CURSOR_REFUSAL,
  FirstPageAction,
  RetryActions,
} from "../../../components/retry-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Events" };

/**
 * How long the page waits on the event-name suggestions before rendering without them. They are
 * cached per admin once read (`listRecentEventNames`), so this only ever bites a first read, or a
 * metrics route that is slow or down — which must never slow the list.
 */
const EVENT_NAME_BUDGET_MS = 800;
const NO_NAMES: readonly string[] = [];

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
 *
 * The date range (A4, #2574) is two IST days in the address (`occurredFrom=2026-11-01`), both
 * inclusive; the API compares instants, so a day becomes its first or last IST instant here. A
 * value that is not a calendar day is refused HERE, before any read, and named: the format is
 * this page's own, and the API would not refuse it — it coerces whatever it gets into a date
 * (`2026-02-30` is 2 March), so it would list a range nobody asked for.
 *
 * The event-name field suggests the names the spine recorded lately (`listRecentEventNames`) — a
 * read the page can do without, so it runs beside the list's and never holds it up.
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

  // Started first, so it runs beside the list's read; it never fails or holds the page.
  const suggestions = withinBudget(listRecentEventNames(), EVENT_NAME_BUDGET_MS, NO_NAMES);

  const occurredFrom = one(sp.occurredFrom);
  const occurredTo = one(sp.occurredTo);
  /** A date in the address that is not a calendar day — refused before any read (see above). */
  const notADay = [occurredFrom, occurredTo].find((d) => d !== undefined && !isCalendarDay(d));
  const filters: EventFilters = {
    eventName: one(sp.eventName),
    actorType: one(sp.actorType),
    subjectType: one(sp.subjectType),
    correlationId: one(sp.correlationId),
    occurredFrom: isCalendarDay(occurredFrom) ? istDayStart(occurredFrom) : undefined,
    occurredTo: isCalendarDay(occurredTo) ? istDayEnd(occurredTo) : undefined,
    cursor: one(sp.cursor),
    limit: 50,
  };

  /** The filters as the ADDRESS carries them — the range as days, not instants. */
  const active = Object.entries({
    eventName: filters.eventName,
    actorType: filters.actorType,
    subjectType: filters.subjectType,
    correlationId: filters.correlationId,
    occurredFrom,
    occurredTo,
  }).filter(([, v]) => Boolean(v));
  const filtered = active.length > 0;

  let page: Awaited<ReturnType<typeof listEvents>> | null = null;
  let failed = false;
  /** A filter in the address the server could have refused (a value it does not accept). */
  const refusable =
    isOverLength(filters.eventName, EVENT_FILTER_MAX_LENGTH.eventName) ||
    isOverLength(filters.actorType, EVENT_FILTER_MAX_LENGTH.actorType) ||
    isOverLength(filters.subjectType, EVENT_FILTER_MAX_LENGTH.subjectType) ||
    isMalformedUuid(filters.correlationId);
  let refusal: ReadRefusal = null;
  if (notADay !== undefined) {
    // This page's own refusal: nothing is read, and the state below names the value.
    failed = true;
    refusal = "filters";
  } else {
    try {
      page = await listEvents(filters);
    } catch (err) {
      // Rendered inline either way, instead of tripping the error boundary. A bad filter value
      // (e.g. a malformed correlation uuid) 400s — the operator's to correct. Anything else is
      // our fault, and "correct the value above" over an outage blames a filter that is fine.
      failed = true;
      // A 400 is the operator's address only when the address holds something to refuse — a
      // filter, or a page cursor. With neither, it cannot be theirs: that is an outage too. The
      // console's one rule, `readRefusal` — and only a filter value the server does not accept
      // counts as refusable: a valid one beside an over-long cursor leaves the CURSOR refused.
      refusal = readRefusal(err, { filtered: refusable, cursor: filters.cursor });
    }
  }
  const refused = refusal !== null;
  /** The filters were refused — not the page cursor beside them. */
  const filtersRefused = refusal === "filters";
  const eventNames = await suggestions;

  /** The current query without the cursor — what the recoveries below repeat. */
  const listHref = queryHref("/events", Object.fromEntries(active));
  /**
   * The ONE "Clear filters" on this screen (owner brief 2026-10-01): in the results head while
   * the list loads, and inside the refusal state when the server refused the filters — there it
   * is the recovery, so the head does not repeat it.
   */
  const clearFilters = filtered ? (
    <Link className="btn btn--ghost" href="/events">
      <Icon name={ACTION_ICON.clearFilters} />
      Clear filters
      <NavPendingCue message="Clearing the filters…" />
    </Link>
  ) : null;

  // The cursor is deliberately dropped when building the "next" link's base, so paging
  // never stacks cursors and a filter change always restarts at page one. `Pager` is the
  // one implementation of that rule — this screen used to hand-roll a second copy of it.

  return (
    <div className="page page--list">
      <PageHeader
        title="Events"
        description="The audit spine: every important state change on the platform is recorded here."
        filters={
          /* Folds behind a "Filters (n)" toggle on a phone (AW-08); unchanged above it. */
          <FilterPanel headingId="filters-heading" heading="Filter events" filters={Object.fromEntries(active)}>
            <EventFilterBar
              eventName={filters.eventName ?? ""}
              actorType={filters.actorType ?? ""}
              subjectType={filters.subjectType ?? ""}
              correlationId={filters.correlationId ?? ""}
              occurredFrom={occurredFrom ?? ""}
              occurredTo={occurredTo ?? ""}
              eventNames={eventNames}
            />
          </FilterPanel>
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
                ? notADay !== undefined
                  ? "A date in the filters is not a calendar day."
                  : filtersRefused
                    ? "That filter combination was rejected."
                    : "Nothing was fetched."
                : `${page?.events.length ?? 0} event${page?.events.length === 1 ? "" : "s"} on this page.`}
            </p>
          </div>
          {filtersRefused ? null : clearFilters}
        </div>

        {refused ? (
          <div className="state state--error">
            <h3 className="state__title">
              {notADay !== undefined
                ? "That date is not on the calendar"
                : filtersRefused
                  ? "The server rejected these filters"
                  : CURSOR_REFUSAL.title}
            </h3>
            <p className="state__body">
              {notADay !== undefined
                ? `Nothing was fetched: “${notADay}” is not a day on the calendar. Pick the date again above, or clear the filters and start again.`
                : filtersRefused
                  ? "Nothing was fetched. A correlation id must be a full UUID — the short id shown in the table is only the first segment. Correct the value above, or clear the filters and start again."
                  : CURSOR_REFUSAL.body}
            </p>
            {/* Repeating a refused request cannot succeed, so there is no Retry. With a filter
                value the server does not accept in the address, that value is what was refused —
                keeping it on the first page would be refused again, and the way out is Clear
                filters. Otherwise the page cursor was refused (the API refuses one only when it
                is longer than any it issues): the first page, filters kept. */}
            {filtersRefused ? (
              <div className="state__actions">{clearFilters}</div>
            ) : (
              <FirstPageAction href={listHref} cursor={filters.cursor} />
            )}
          </div>
        ) : failed ? (
          <div className="state state--error">
            <h3 className="state__title">Events are unavailable</h3>
            <p className="state__body">
              The audit spine did not answer, and that is a fault on our side rather than
              anything in the filters. Nothing has been lost: events are recorded as they
              happen and will all be here once the read succeeds.
            </p>
            {/* The SAME query — filters and cursor kept — and, past page one, the first page of
                it. Neither is "Clear filters", which the results head already offers. */}
            <RetryActions href={listHref} cursor={filters.cursor} />
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
            pager={
              <Pager
                basePath="/events"
                params={Object.fromEntries(active)}
                cursor={filters.cursor}
                nextCursor={page?.nextCursor}
                note="Paging uses a keyset cursor, so new events arriving mid-scan cannot make rows skip or repeat."
              />
            }
          />
        )}
      </section>
    </div>
  );
}
