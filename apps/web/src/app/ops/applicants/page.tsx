import Link from "next/link";

// Read-only navigation page; no data fetching, but keep it dynamic like the
// other ops routes for consistency.
export const dynamic = "force-dynamic";

/**
 * Applicants landing page (ADR-0009 alpha swipe-to-apply, ops read-only).
 *
 * The API exposes applicant data only per-job and per-worker (there is no
 * jobs-list ops endpoint), so this page is a lookup surface: enter a job id to
 * see its applicants, or a worker id to see that worker's applications. Both
 * forms are native GET forms — no client JS, no mutation — that re-render this
 * page with the id in the query string and surface a link into the detail view.
 */
export default async function ApplicantsPage({
  searchParams,
}: {
  searchParams: Promise<{ jobId?: string; workerId?: string }>;
}) {
  const { jobId, workerId } = await searchParams;
  const trimmedJobId = jobId?.trim() || null;
  const trimmedWorkerId = workerId?.trim() || null;

  return (
    <>
      <h1 className="page-title">Applicants</h1>
      <p className="page-sub">
        Read-only view of swipe-to-apply decisions. <span className="badge">Alpha</span>
      </p>

      <div className="cards">
        <div className="card">
          <h3>Applicants by job</h3>
          <p>Enter a job id to list everyone who applied to or skipped it.</p>
          <form method="get" style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <label htmlFor="jobId" className="sr-only">
              Job id
            </label>
            <input
              id="jobId"
              name="jobId"
              type="text"
              inputMode="text"
              autoComplete="off"
              placeholder="job id (UUID)"
              defaultValue={trimmedJobId ?? ""}
              className="input"
            />
            <button type="submit" className="btn">
              Look up
            </button>
          </form>
          {trimmedJobId ? (
            <p style={{ marginTop: 10 }}>
              <Link href={`/ops/jobs/${trimmedJobId}/applicants`}>
                View applicants for {trimmedJobId} →
              </Link>
            </p>
          ) : null}
        </div>

        <div className="card">
          <h3>Applications by worker</h3>
          <p>Enter a worker id to list the jobs that worker applied to or skipped.</p>
          <form method="get" style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <label htmlFor="workerId" className="sr-only">
              Worker id
            </label>
            <input
              id="workerId"
              name="workerId"
              type="text"
              inputMode="text"
              autoComplete="off"
              placeholder="worker id (UUID)"
              defaultValue={trimmedWorkerId ?? ""}
              className="input"
            />
            <button type="submit" className="btn">
              Look up
            </button>
          </form>
          {trimmedWorkerId ? (
            <p style={{ marginTop: 10 }}>
              <Link href={`/ops/workers/${trimmedWorkerId}/applications`}>
                View applications for {trimmedWorkerId} →
              </Link>
            </p>
          ) : null}
        </div>
      </div>

      <div className="footer">
        Read-only. Applicant reads return opaque worker ids only (no name/phone) and coarse job
        fields only (no employer/pay). Ops cannot apply or skip from here.
      </div>
    </>
  );
}
