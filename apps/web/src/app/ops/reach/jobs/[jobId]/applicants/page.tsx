import Link from "next/link";
import { getReachJobApplicants, ApiError, type ApplicantList } from "@/lib/api";
import { UnlockActions } from "./unlock-actions";

// Live ops data — always fetched fresh from the API at request time.
export const dynamic = "force-dynamic";

/**
 * Reach — View A by path param: `GET /reach/jobs/:jobId/applicants` (ADR-0011).
 *
 * A clean, linkable URL for one job's ranked ELIGIBLE WORKER POOL — NOT the people who
 * applied. The route is `ReachService.applicantsForJob`, the deterministic RANK core's
 * faceless pool; most of those workers never applied to this job. The label says so
 * (#1962); the job's REAL applicants are a different read, linked below.
 *
 * Identical faceless rows to the /ops/reach landing page: opaque `workerId`, `rank`,
 * `score`, HOT/PUSH badges, and the explainable `components[]` "why". SORT-NEVER-BLOCK —
 * the whole pool appears.
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
    data = await getReachJobApplicants(jobId);
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
        <Link href="/ops/reach">← Reach (suggested workers)</Link>
      </p>
      <h1 className="page-title">Suggested workers (ranked pool)</h1>
      <p className="page-sub">
        Job <span className="mono">{jobId}</span>
      </p>
      {/* The pool above is SUGGESTED eligible workers, not applicants. The job's REAL
          applicants are a different read — link to it so the two are never conflated (#1962). */}
      <p className="page-sub">
        <Link href={`/ops/jobs/${jobId}/applicants`}>View the job&rsquo;s real applicants →</Link>
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
            <span className="mono">{data.applicants.length}</span> worker
            {data.applicants.length === 1 ? "" : "s"} in pool.
          </p>
          <p className="note">
            <strong>Sort-never-block:</strong> everyone in the pool appears here. A low score
            means a low rank, <strong>not</strong> exclusion.
          </p>

          {data.applicants.length === 0 ? (
            <div className="empty">The worker pool is empty.</div>
          ) : (
            // Faceless applicants (opaque worker ids only) are passed into the
            // client component, which drives the server-action-backed unlock +
            // reveal flow. Data-fetching stays here on the server.
            <UnlockActions jobId={jobId} applicants={data.applicants} />
          )}
        </>
      ) : null}

      <div className="footer">
        Faceless surface: opaque worker ids, ranking signals, and the explainable &ldquo;why&rdquo;
        only. No phone/name/employer is returned by the API. Unlock reveals a{" "}
        <strong>routed relay handle</strong> — never a phone number — and an
        &ldquo;unavailable&rdquo; result never discloses its cause (no-oracle).
      </div>
    </>
  );
}
