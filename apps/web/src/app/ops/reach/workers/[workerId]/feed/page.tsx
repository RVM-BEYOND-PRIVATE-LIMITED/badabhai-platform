import Link from "next/link";
import { getWorkerFeed, ApiError, type WorkerFeed } from "@/lib/api";
import { formatScore, WhyDetails } from "@/components/reach";

// Live ops data — always fetched fresh from the API at request time.
export const dynamic = "force-dynamic";

/**
 * Reach — View B: worker job feed (`GET /reach/workers/:workerId/feed`, ADR-0011).
 *
 * The ranked list of jobs for one worker. Faceless rows: opaque `jobId`, `rank`,
 * `score`, and the explainable `components[]` "why". Per ADR D4 this view has NO
 * `hot` / `pushEligible` (they have no cross-job meaning). The `jobId` is shown
 * prominently and links straight into View A so ops can inspect that job's pool.
 *
 * SORT-NEVER-BLOCK: every candidate job appears (`feed.length === candidateJobs
 * length`); a low score means low rank, never exclusion.
 */
export default async function WorkerFeedPage({
  params,
}: {
  params: Promise<{ workerId: string }>;
}) {
  const { workerId } = await params;

  let data: WorkerFeed | null = null;
  let error: string | null = null;
  let notFound = false;
  try {
    data = await getWorkerFeed(workerId);
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
        <Link href={`/ops/workers/${workerId}`}>← Worker</Link> ·{" "}
        <Link href="/ops/reach">Reach (applicant list)</Link>
      </p>
      <h1 className="page-title">Reach feed (View B)</h1>
      <p className="page-sub">
        Ranked jobs for worker <span className="mono">{workerId}</span>
      </p>

      {notFound ? (
        <p className="page-sub">
          <span className="badge">No profile</span> Worker <span className="mono">{workerId}</span>{" "}
          has no profile yet, so there is no job feed.
        </p>
      ) : error ? (
        <p className="page-sub">
          <span className="badge">API unavailable</span> {error}
        </p>
      ) : data ? (
        <>
          <p className="page-sub">
            {data.feed.length} job{data.feed.length === 1 ? "" : "s"} (whole candidate set).
          </p>
          <p className="note">
            <strong>Sort-never-block:</strong> every candidate job appears here. A low score means
            a low rank, <strong>not</strong> exclusion. Each <strong>jobId</strong> links into the
            applicant list (View A) for that job.
          </p>

          {data.feed.length === 0 ? (
            <div className="empty">No candidate jobs.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Job ID</th>
                  <th>Score</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {data.feed.map((j) => (
                  <tr key={j.jobId}>
                    <td>{j.rank}</td>
                    <td className="mono">
                      <Link href={`/ops/reach/jobs/${j.jobId}/applicants`}>{j.jobId}</Link>
                    </td>
                    <td>{formatScore(j.score)}</td>
                    <td>
                      <WhyDetails components={j.components} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : null}

      <div className="footer">
        Faceless surface: opaque job ids, ranking signals, and the explainable &ldquo;why&rdquo;
        only. No employer name or raw job PII is returned by the API or shown here. View B carries
        no HOT / PUSH (no cross-job meaning — ADR-0011 D4).
      </div>
    </>
  );
}
