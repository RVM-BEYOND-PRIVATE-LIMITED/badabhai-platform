/**
 * Event stream — PLACEHOLDER. Will read the `events` table (read-only).
 */
const SAMPLE = [
  { name: "worker.otp_verified", actor: "worker", occurred: "2026-06-08T10:00:00Z" },
  { name: "consent.accepted", actor: "worker", occurred: "2026-06-08T10:00:05Z" },
  { name: "chat.message_received", actor: "worker", occurred: "2026-06-08T10:01:00Z" },
  { name: "profile.extraction_completed", actor: "ai_service", occurred: "2026-06-08T10:02:00Z" },
];

export default function EventsPage() {
  return (
    <>
      <h1 className="page-title">Events</h1>
      <p className="page-sub">
        Read-only event stream (event-first audit log). <span className="badge">Placeholder data</span>
      </p>

      <table>
        <thead>
          <tr>
            <th>Event name</th>
            <th>Actor</th>
            <th>Occurred at</th>
          </tr>
        </thead>
        <tbody>
          {SAMPLE.map((e, i) => (
            <tr key={i}>
              <td>{e.name}</td>
              <td>{e.actor}</td>
              <td>{e.occurred}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="footer">
        TODO: paginate the <code>events</code> table. Payloads carry ids/hashes only — never raw PII.
      </div>
    </>
  );
}
