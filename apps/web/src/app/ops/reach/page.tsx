import Link from "next/link";
import {
  getReachJobApplicants,
  listJobPostings,
  ApiError,
  type ApplicantList,
  type JobPostingRow,
} from "@/lib/api";
import { formatScore, WhyDetails } from "@/components/reach";
import { StatusBadge } from "@/components/status-badge";

// Live ops data — always fetched fresh from the API at request time.
export const dynamic = "force-dynamic";

/**
 * Reach — View A: payer applicant list (ADR-0011).
 *
 * Landing page for the Reach section. Takes a `jobId` (via the GET form below or a
 * `?jobId=` query param) and renders the ranked, FACELESS applicant pool for that job:
 * opaque `workerId`, `rank`, `score`, a HOT badge when `hot`, a PUSH badge when
 * `pushEligible`, and the explainable `components[]` "why". No contact/name/employer —
 * the API does not return any and this view never fetches or invents it.
 *
 * SORT-NEVER-BLOCK: every worker in the pool appears (`applicants.length === pool
 * length`); a low score means low rank, never exclusion.
 */
export default async function ReachApplicantsPage({
  searchParams,
}: {
  searchParams: Promise<{ jobId?: string }>;
}) {
  const { jobId: rawJobId } = await searchParams;
  const jobId = rawJobId?.trim() ?? "";

  // Job-posting picker (entry point of the ops employer workflow). Independent
  // of the paste-jobId fallback below: a posting-list outage must not hide the
  // manual form, so its error/empty state is tracked separately.
  let postings: JobPostingRow[] = [];
  let postingsError: string | null = null;
  try {
    postings = await listJobPostings();
  } catch (e) {
    postingsError = e instanceof Error ? e.message : String(e);
  }

  let data: ApplicantList | null = null;
  let error: string | null = null;
  let notFound = false;
  if (jobId) {
    try {
      data = await getReachJobApplicants(jobId);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        notFound = true;
      } else {
        error = e instanceof Error ? e.message : String(e);
      }
    }
  }

  return (
    <>
      <h1 className="page-title">Reach · Applicant list (View A)</h1>
      <p className="page-sub">
        The ranked applicant pool for one job — faceless rows over the deterministic RANK core.
      </p>

      <h2 className="page-sub">Pick a job posting</h2>
      <p className="note">
        Pick an ops-created posting to open its ranked, faceless applicant pool. Org/role/location
        text below is ops-entered (internal register) — the faceless rule applies to the applicant
        feed, not to this picker.
      </p>
      <p className="note">
        Heads-up: ranked applicants only appear once a posting is wired into Reach. That binding is
        still pending, so a real posting may currently return an{" "}
        <span className="badge">Unknown job</span> on its applicant page — that&apos;s expected, not
        an outage.
      </p>

      {postingsError ? (
        <p className="page-sub">
          <span className="badge">API unavailable</span> {postingsError}
        </p>
      ) : postings.length === 0 ? (
        <div className="empty">
          No job postings yet. Create one under{" "}
          <Link href="/ops/job-postings">Job Postings</Link>, or paste a jobId below.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Role title</th>
              <th>Org</th>
              <th>Location</th>
              <th>Vacancy band</th>
              <th>Status</th>
              <th>Applicants</th>
            </tr>
          </thead>
          <tbody>
            {postings.map((p) => (
              <tr key={p.id}>
                <td>{p.roleTitle}</td>
                <td>{p.orgLabel}</td>
                <td>{p.locationLabel ?? "—"}</td>
                <td>{p.vacancyBand}</td>
                <td>
                  <StatusBadge status={p.status} />
                </td>
                <td>
                  <Link href={`/ops/reach/jobs/${p.id}/applicants`}>View applicants →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="page-sub">Or paste a jobId</h2>
      <p className="note">
        Paste a <strong>jobId</strong> (a UUID — e.g. one copied from a worker&apos;s{" "}
        <strong>Reach feed</strong>). This is the fallback for ids that aren&apos;t in the posting
        picker above.
      </p>

      <form className="inline-form" method="get" action="/ops/reach">
        <input
          type="text"
          name="jobId"
          defaultValue={jobId}
          placeholder="jobId (UUID)"
          aria-label="Job ID"
        />
        <button type="submit">View applicants</button>
      </form>

      {!jobId ? (
        <div className="empty">Enter a jobId above to see its ranked applicant pool.</div>
      ) : notFound ? (
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
            Job <span className="mono">{data.jobId}</span> · {data.applicants.length} applicant
            {data.applicants.length === 1 ? "" : "s"} (whole pool).
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
        only. No phone/name/employer is returned by the API or shown here. To find a jobId, open a{" "}
        <Link href="/ops/workers">worker</Link> and follow its Reach feed.
      </div>
    </>
  );
}
