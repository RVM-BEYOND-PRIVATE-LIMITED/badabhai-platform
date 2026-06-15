import Link from "next/link";
import { getWorkerProfile, type WorkerProfileDetail } from "@/lib/api";

// Live ops data — always fetched fresh from the API at request time.
export const dynamic = "force-dynamic";

/**
 * Worker profile detail — wired to GET /workers/:id/profile.
 * This view intentionally never displays raw PII (phone/full name).
 */
export default async function WorkerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let data: WorkerProfileDetail | null = null;
  let error: string | null = null;
  try {
    data = await getWorkerProfile(id);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <>
      <p className="page-sub">
        <Link href="/ops/workers">← Workers</Link>
      </p>
      <h1 className="page-title">Worker {id}</h1>
      <p className="page-sub">
        <Link href={`/ops/workers/${id}/applications`}>View applications →</Link>
      </p>

      {error ? (
        <p className="page-sub">
          <span className="badge">Not available</span> {error}
        </p>
      ) : data ? (
        <>
          <p className="page-sub">
            Status: {data.worker.status} · Language: {data.worker.preferred_language ?? "—"}
          </p>
          <div className="cards">
            <div className="card">
              <h3>Profile</h3>
              {data.profile ? (
                <>
                  <p>Status: {data.profile.profileStatus}</p>
                  <p>Role: {data.profile.canonicalRoleId ?? "—"}</p>
                  <p>Trade: {data.profile.canonicalTradeId ?? "—"}</p>
                  <p>Skills: {data.profile.skills.length ? data.profile.skills.join(", ") : "—"}</p>
                  <p>
                    Machines:{" "}
                    {data.profile.machines.length ? data.profile.machines.join(", ") : "—"}
                  </p>
                </>
              ) : (
                <p>No profile extracted yet.</p>
              )}
            </div>
            <div className="card">
              <h3>Latest resume</h3>
              {data.resume ? (
                <>
                  <p>Version: {data.resume.version}</p>
                  <pre style={{ whiteSpace: "pre-wrap" }}>{data.resume.resumeText}</pre>
                </>
              ) : (
                <p>No resume generated yet.</p>
              )}
            </div>
          </div>
        </>
      ) : null}

      <div className="footer">PII is never rendered here — the API does not return phone/full name.</div>
    </>
  );
}
