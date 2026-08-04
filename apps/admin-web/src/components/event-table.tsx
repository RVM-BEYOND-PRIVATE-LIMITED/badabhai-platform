import Link from "next/link";
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
}: {
  events: EventListItem[];
  emptyMessage?: string;
}) {
  if (events.length === 0) {
    return <p className="empty">{emptyMessage}</p>;
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
