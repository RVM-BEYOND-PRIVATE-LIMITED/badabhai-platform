import Link from "next/link";
import { getJobApplicants, ApiError, type ApplicantList } from "@/lib/api";
import { formatScore, WhyDetails } from "@/components/reach";

// Live ops data — always fetched fresh from the API at request time.
export const dynamic = "force-dynamic";

/**
 * Reach — View A by path param: `GET /reach/jobs/:jobId/applicants` (ADR-0011).
 *
 * A clean, linkable URL for one job's ranked applicant pool. Identical faceless rows to
 * the /ops/reach landing page: opaque `workerId`, `rank`, `score`, HOT/PUSH badges, and
 * the explainable `components[]` "why". SORT-NEVER-BLOCK — the whole pool appears.
 */
export default async function JobApplicantsPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;

  let data: ApplicantList | null = null;
  let error: string | null = null;
  let notFound = false;
  try {
    data = await getJobApplicants(jobId);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      notFound = true;
    } else {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  return (
    <>
      <p className="page-sub">
        <Link href="/ops/reach">← Reach (applicant list)</Link>
      </p>
      <h1 className="page-title">Applicants for job</h1>
      <p className="page-sub">
        Job <span className="mono">{jobId}</span>
      </p>

      {notFound ? (
        <p className="page-sub">
          <span className="badge">Unknown job</span> No job found for{" "}
          <span className="mono">{jobId}</span>. Check the id (it must be a UUID from a worker
          feed).
        </p>
      ) : error ? (
        <p className="page-sub">
          <span className="badge">API unavailable</span> {error}
        </p>
      ) : data ? (
        <>
          <p className="page-sub">
            {data.applicants.length} applicant{data.applicants.length === 1 ? "" : "s"} (whole
            pool).
          </p>
          <p className="note">
            <strong>Sort-never-block:</strong> everyone in the pool appears here. A low score
            means a low rank, <strong>not</strong> exclusion.
          </p>

          {data.applicants.length === 0 ? (
            <div className="empty">The worker pool is empty.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Worker ID</th>
                  <th>Score</th>
                  <th>Flags</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {data.applicants.map((a) => (
                  <tr key={a.workerId}>
                    <td>{a.rank}</td>
                    <td className="mono">{a.workerId}</td>
                    <td>{formatScore(a.score)}</td>
                    <td>
                      {a.hot ? <span className="badge badge-hot">HOT</span> : null}
                      {a.hot && a.pushEligible ? " " : null}
                      {a.pushEligible ? <span className="badge badge-push">PUSH</span> : null}
                      {!a.hot && !a.pushEligible ? "—" : null}
                    </td>
                    <td>
                      <WhyDetails components={a.components} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : null}

      <div className="footer">
        Faceless surface: opaque worker ids, ranking signals, and the explainable &ldquo;why&rdquo;
        only. No phone/name/employer is returned by the API or shown here.
      </div>
    </>
  );
}
