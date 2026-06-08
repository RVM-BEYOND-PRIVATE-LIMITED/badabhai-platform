import Link from "next/link";
import { listWorkers, type WorkerListItem } from "@/lib/api";

// Live ops data — always fetched fresh from the API at request time.
export const dynamic = "force-dynamic";

/** Workers table — wired to GET /workers (no PII: phone/name are never returned). */
export default async function WorkersPage() {
  let workers: WorkerListItem[] = [];
  let error: string | null = null;
  try {
    workers = await listWorkers();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <>
      <h1 className="page-title">Workers</h1>
      <p className="page-sub">Profiled workers (newest first).</p>

      {error ? (
        <p className="page-sub">
          <span className="badge">API unavailable</span> {error}
        </p>
      ) : workers.length === 0 ? (
        <p className="page-sub">No workers yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Worker ID</th>
              <th>Status</th>
              <th>Canonical role</th>
              <th>Profile</th>
            </tr>
          </thead>
          <tbody>
            {workers.map((w) => (
              <tr key={w.id}>
                <td>
                  <Link href={`/ops/workers/${w.id}`}>{w.id}</Link>
                </td>
                <td>{w.status}</td>
                <td>{w.canonical_role_id ?? "—"}</td>
                <td>{w.profile_status ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="footer">PII (phone/name) is never shown here — it is not returned by the API.</div>
    </>
  );
}
