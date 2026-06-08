/**
 * AI jobs — PLACEHOLDER. Will read the `ai_jobs` table.
 */
const SAMPLE = [
  { type: "profile_extraction", status: "completed" },
  { type: "pseudonymization", status: "completed" },
  { type: "resume_generation", status: "queued" },
];

export default function AiJobsPage() {
  return (
    <>
      <h1 className="page-title">AI Jobs</h1>
      <p className="page-sub">
        Async AI work (pseudonymization, extraction, resume).{" "}
        <span className="badge">Placeholder data</span>
      </p>

      <table>
        <thead>
          <tr>
            <th>Job type</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {SAMPLE.map((j, i) => (
            <tr key={i}>
              <td>{j.type}</td>
              <td>{j.status}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="footer">TODO: wire to the `ai_jobs` table; add filtering by status.</div>
    </>
  );
}
