import Link from "next/link";
import { getJobApplicants, type JobApplicants } from "@/lib/api";

// Live ops data — always fetched fresh from the API at request time.
export const dynamic = "force-dynamic";

/**
 * Applicants for a job — wired to GET /jobs/:jobId/applicants
 * (ops, InternalServiceGuard). PII-FREE: the API returns opaque worker_ids only,
 * never a name or phone, so there is nothing to render beyond the id.
 */
export default async function JobApplicantsPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;

  let data: JobApplicants | null = null;
  let error: string | null = null;
  try {
    data = await getJobApplicants(jobId);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <>
      <p className="page-sub">
        <Link href="/ops/applicants">← Applicants</Link>
      </p>
      <h1 className="page-title">Job {jobId}</h1>
      <p className="page-sub">Applicants on this job (read-only).</p>

      {error ? (
        <p className="page-sub">
          <span className="badge">Not available</span> {error}
        </p>
      ) : !data || data.applicants.length === 0 ? (
        <p className="page-sub">No applicants yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Worker ID</th>
              <th>Action</th>
              <th>Reason</th>
              <th>Source</th>
              <th>Rank</th>
              <th>Created at</th>
              <th>Updated at</th>
            </tr>
          </thead>
          <tbody>
            {data.applicants.map((a) => (
              <tr key={a.worker_id}>
                <td>
                  <Link href={`/ops/workers/${a.worker_id}/applications`}>{a.worker_id}</Link>
                </td>
                <td>{a.action}</td>
                <td>{a.reason ?? "—"}</td>
                <td>{a.source_surface}</td>
                <td>{a.rank ?? "—"}</td>
                <td>{new Date(a.created_at).toISOString()}</td>
                <td>{new Date(a.updated_at).toISOString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="footer">
        PII is never rendered here — the API returns opaque worker ids only (no name/phone), and no
        employer or pay.
      </div>
    </>
  );
}
