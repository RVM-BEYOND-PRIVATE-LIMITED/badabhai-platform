import { listAiJobs, type AiJobListItem } from "@/lib/api";

// Live ops data — always fetched fresh from the API at request time.
export const dynamic = "force-dynamic";

/** AI jobs — wired to GET /ai-jobs (refs only, never raw PII). */
export default async function AiJobsPage() {
  let jobs: AiJobListItem[] = [];
  let error: string | null = null;
  try {
    jobs = await listAiJobs();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <>
      <h1 className="page-title">AI Jobs</h1>
      <p className="page-sub">Async AI work (pseudonymization, extraction, resume), newest first.</p>

      {error ? (
        <p className="page-sub">
          <span className="badge">API unavailable</span> {error}
        </p>
      ) : jobs.length === 0 ? (
        <p className="page-sub">No AI jobs yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Job type</th>
              <th>Status</th>
              <th>Created at</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>{j.job_type}</td>
                <td>{j.status}</td>
                <td>{new Date(j.created_at).toISOString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="footer">Job input/output references carry ids only — never raw PII.</div>
    </>
  );
}
