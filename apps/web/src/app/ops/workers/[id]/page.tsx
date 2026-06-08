import Link from "next/link";

/**
 * Worker profile detail — PLACEHOLDER. Will call GET /workers/:id/profile.
 * Note: this view intentionally never displays raw PII (phone/full name).
 */
export default async function WorkerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <>
      <p className="page-sub">
        <Link href="/ops/workers">← Workers</Link>
      </p>
      <h1 className="page-title">Worker {id}</h1>
      <p className="page-sub">
        Profile + latest resume. <span className="badge">Placeholder</span>
      </p>

      <div className="cards">
        <div className="card">
          <h3>Profile</h3>
          <p>profile_status, canonical role/trade, skills, machines, experience — TODO.</p>
        </div>
        <div className="card">
          <h3>Latest resume</h3>
          <p>Generated resume text/version — TODO.</p>
        </div>
        <div className="card">
          <h3>Consent</h3>
          <p>Latest consent version + purposes — TODO.</p>
        </div>
      </div>

      <div className="footer">
        TODO: fetch from <code>GET /workers/{id}/profile</code>. PII is never rendered here.
      </div>
    </>
  );
}
