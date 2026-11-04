import Link from "next/link";
import type { ReactNode } from "react";
import type { EventListItem } from "../lib/events";
import { formatRelative, humanizeEventName, shortId, timestampTitle } from "../lib/format";
import { CopyId } from "./copy-id";
import { DataGrid, type GridColumn } from "./data-grid";
import { NavPendingCue } from "./nav-pending";

/**
 * The event columns, as the data grid draws them (A4, #2574). Already-fetched, PII-free rows:
 * ids, enums and timestamps. The event's name is the row's link (its own page); the correlation
 * id links the whole chain on the Events list, as a filter.
 */
const COLUMNS: readonly GridColumn<EventListItem>[] = [
  {
    id: "when",
    header: "When",
    width: "date",
    // Relative for scanning, absolute in the title so an incident review can still get the
    // exact instant.
    cell: (e) => (
      <time dateTime={e.occurred_at} title={timestampTitle(e.occurred_at)}>
        {formatRelative(e.occurred_at)}
      </time>
    ),
  },
  {
    id: "event",
    header: "Event",
    cell: (e) => humanizeEventName(e.event_name),
    trail: (e) => <span className="table__meta">v{e.event_version}</span>,
    title: (e) => `${e.event_name} · v${e.event_version}`,
  },
  {
    id: "actor",
    header: "Actor",
    width: "typed-id",
    cell: (e) => (
      <>
        <span className="tag" title={e.actor_type}>
          {e.actor_type}
        </span>
        <span className="mono" title={e.actor_id ?? undefined}>
          {shortId(e.actor_id)}
        </span>
        {e.actor_id ? <CopyId id={e.actor_id} label="actor id" /> : null}
      </>
    ),
  },
  {
    id: "subject",
    header: "Subject",
    width: "typed-id",
    cell: (e) => (
      <>
        <span className="tag" title={e.subject_type}>
          {e.subject_type}
        </span>
        <span className="mono" title={e.subject_id ?? undefined}>
          {shortId(e.subject_id)}
        </span>
        {e.subject_id ? <CopyId id={e.subject_id} label="subject id" /> : null}
      </>
    ),
  },
  {
    id: "correlation",
    header: "Correlation",
    width: "id",
    cell: (e) => (
      <>
        <Link
          className="link mono"
          href={`/events?correlationId=${encodeURIComponent(e.correlation_id)}`}
          title={`Show the whole chain: ${e.correlation_id}`}
        >
          {shortId(e.correlation_id)}
          {/* A filter change like any other: the list shows it is under way (A4). */}
          <NavPendingCue message="Loading the whole chain…" />
        </Link>
        <CopyId id={e.correlation_id} label="correlation id" />
      </>
    ),
  },
];

/**
 * The event feed — the Events list, every entity timeline and the dashboard's recent activity.
 * A Server Component: it hands already-fetched rows to the data grid (components/data-grid.tsx),
 * which draws them, pages them (`pager`) and lets the viewer choose columns and density.
 */
export function EventTable({
  events,
  emptyMessage = "No events match these filters.",
  emptyBody,
  emptyAction,
  gridId = "events",
  pager,
  viewControls = true,
}: {
  events: EventListItem[];
  emptyMessage?: string;
  /** WHY this surface can legitimately be empty. Caller-supplied — see the note below. */
  emptyBody?: ReactNode;
  /** What to do next, if there is anything useful to do. Omit when there is not. */
  emptyAction?: ReactNode;
  /** Whose column choices these are — the Events list and the timelines share "events". */
  gridId?: string;
  /** The pager, drawn in the grid's footer bar. */
  pager?: ReactNode;
  /** The column chooser and density toggle — off for the dashboard's small panel. */
  viewControls?: boolean;
}) {
  if (events.length === 0) {
    /**
     * An empty state says WHAT is empty, WHY, and what to do next — but only the caller
     * knows the last two, so they are props rather than a fixed sentence.
     *
     * This used to hardcode "a narrow filter can hide a busy day… widen the filters" plus a
     * "View all events" link, which was wrong at two of the three call sites: the dashboard
     * widget has no filters to widen and already renders that exact link in its panel head
     * (so the empty state emitted a duplicate link with the same name and target inside one
     * panel), and on an unfiltered /events the link pointed at the page you were already on.
     * The file's own comment claimed the reason "stays theirs" while appending a shared one.
     */
    return (
      <div className="state">
        <h3 className="state__title">{emptyMessage}</h3>
        {emptyBody ? <p className="state__body">{emptyBody}</p> : null}
        {emptyAction ? <div className="state__actions">{emptyAction}</div> : null}
      </div>
    );
  }

  return (
    <DataGrid
      id={gridId}
      caption="Platform events, newest first"
      columns={COLUMNS}
      rows={events}
      rowKey={(e) => e.id}
      rowLink={{
        column: "event",
        href: (e) => `/events/${e.id}`,
        name: (e) => humanizeEventName(e.event_name),
      }}
      pager={pager}
      viewControls={viewControls}
    />
  );
}
