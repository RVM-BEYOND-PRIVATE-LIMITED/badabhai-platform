import Link from "next/link";
import { getWorkerApplications, type WorkerApplications } from "@/lib/api";

// Live ops data — always fetched fresh from the API at request time.
export const dynamic = "force-dynamic";

/**
 * A worker's applications — wired to GET /workers/:workerId/applications
 * (ops, InternalServiceGuard). Coarse job fields only (no employer, no pay) plus
 * the worker's decision. No raw PII is returned or rendered.
 */
export default async function WorkerApplicationsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let data: WorkerApplications | null = null;
  let error: string | null = null;
  try {
    data = await getWorkerApplications(id);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <>
      <p className="page-sub">
        <Link href={`/ops/workers/${id}`}>← Worker</Link>
      </p>
      <h1 className="page-title">Applications · {id}</h1>
      <p className="page-sub">Jobs this worker applied to or skipped (read-only).</p>

      {error ? (
        <p className="page-sub">
          <span className="badge">Not available</span> {error}
        </p>
      ) : !data || data.applications.length === 0 ? (
        <p className="page-sub">No applications yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th>Trade</th>
              <th>Title</th>
              <th>City</th>
              <th>Area</th>
              <th>Action</th>
              <th>Reason</th>
              <th>Source</th>
              <th>Rank</th>
              <th>Updated at</th>
            </tr>
          </thead>
          <tbody>
            {data.applications.map((a) => (
              <tr key={a.job_id}>
                <td>
                  <Link href={`/ops/jobs/${a.job_id}/applicants`}>{a.job_id}</Link>
                </td>
                <td>{a.trade_key}</td>
                <td>{a.title}</td>
                <td>{a.city}</td>
                <td>{a.area ?? "—"}</td>
                <td>{a.action}</td>
                <td>{a.reason ?? "—"}</td>
                <td>{a.source_surface}</td>
                <td>{a.rank ?? "—"}</td>
                <td>{new Date(a.updated_at).toISOString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="footer">
        Coarse job fields only — never employer or pay. The worker is shown by opaque id; no
        phone/full name is returned by the API.
      </div>
    </>
  );
}
