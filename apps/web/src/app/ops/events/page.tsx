import { listEvents, type EventListItem } from "@/lib/api";

// Live ops data — always fetched fresh from the API at request time.
export const dynamic = "force-dynamic";

/** Event stream — wired to GET /events (read-only; payloads carry ids/hashes only). */
export default async function EventsPage() {
  let events: EventListItem[] = [];
  let error: string | null = null;
  try {
    events = await listEvents();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <>
      <h1 className="page-title">Events</h1>
      <p className="page-sub">Read-only event stream (event-first audit log), newest first.</p>

      {error ? (
        <p className="page-sub">
          <span className="badge">API unavailable</span> {error}
        </p>
      ) : events.length === 0 ? (
        <p className="page-sub">No events yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Event name</th>
              <th>Actor</th>
              <th>Subject</th>
              <th>Occurred at</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td>{e.event_name}</td>
                <td>{e.actor_type}</td>
                <td>{e.subject_type}</td>
                <td>{new Date(e.occurred_at).toISOString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="footer">Payloads carry ids/hashes only — never raw PII.</div>
    </>
  );
}
