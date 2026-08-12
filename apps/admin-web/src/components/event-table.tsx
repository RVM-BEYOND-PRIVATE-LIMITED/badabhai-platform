import Link from "next/link";
import type { ReactNode } from "react";
import type { EventListItem } from "../lib/events";
import { formatRelative, formatTimestamp, humanizeEventName, shortId } from "../lib/format";

/**
 * The event feed table — a Server Component: it renders already-fetched, PII-free rows
 * and needs no interactivity, so none of this ships to the browser.
 *
 * Wide content scrolls inside its own container rather than stretching the page, which is
 * what keeps the shell usable on a laptop with the sidebar open.
 */
export function EventTable({
  events,
  emptyMessage = "No events match these filters.",
  emptyBody,
  emptyAction,
}: {
  events: EventListItem[];
  emptyMessage?: string;
  /** WHY this surface can legitimately be empty. Caller-supplied — see the note below. */
  emptyBody?: ReactNode;
  /** What to do next, if there is anything useful to do. Omit when there is not. */
  emptyAction?: ReactNode;
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
    <div className="tablewrap">
      <table className="table">
        <caption className="sr-only">Platform events, newest first</caption>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Event</th>
            <th scope="col">Actor</th>
            <th scope="col">Subject</th>
            <th scope="col">Correlation</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td>
                {/* Relative for scanning, absolute in the title so an incident review can
                    still get the exact instant. */}
                <time dateTime={e.occurred_at} title={formatTimestamp(e.occurred_at)}>
                  {formatRelative(e.occurred_at)}
                </time>
              </td>
              <td>
                <Link className="link" href={`/events/${e.id}`}>
                  {humanizeEventName(e.event_name)}
                </Link>
                <span className="table__meta">v{e.event_version}</span>
              </td>
              <td>
                <span className="tag">{e.actor_type}</span>
                <span className="mono" title={e.actor_id ?? undefined}>
                  {shortId(e.actor_id)}
                </span>
              </td>
              <td>
                <span className="tag">{e.subject_type}</span>
                <span className="mono" title={e.subject_id ?? undefined}>
                  {shortId(e.subject_id)}
                </span>
              </td>
              <td>
                <Link
                  className="link mono"
                  href={`/events?correlationId=${encodeURIComponent(e.correlation_id)}`}
                  title={`Show the whole chain: ${e.correlation_id}`}
                >
                  {shortId(e.correlation_id)}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
