import Link from "next/link";
import { getJobPosting, type JobPostingRow } from "@/lib/api";
import { StatusBadge } from "@/components/status-badge";
import { PostingActions } from "./posting-actions";

// Live ops data — always fetched fresh from the API at request time.
export const dynamic = "force-dynamic";

/** ISO timestamp formatter; tolerant of null (e.g. closed_at on an open row). */
function fmt(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString();
}

/**
 * Job posting detail — wired to GET /job-postings/:id (404 -> error state).
 * Shows every field, the lifecycle status, and timestamps. The free-text values
 * (org/role/location/description) legitimately display here: they live on the row
 * and ops needs to see them. The PII rule is about events/logs, not this internal
 * register view.
 */
export default async function JobPostingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let posting: JobPostingRow | null = null;
  let error: string | null = null;
  try {
    posting = await getJobPosting(id);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <>
      <p className="page-sub">
        <Link href="/ops/job-postings">← Job Postings</Link>
      </p>

      {error ? (
        <>
          <h1 className="page-title">Job posting</h1>
          <p className="page-sub">
            <span className="badge">Not available</span> {error}
          </p>
        </>
      ) : posting ? (
        <>
          <div className="btn-row" style={{ gap: 12 }}>
            <h1 className="page-title" style={{ margin: 0 }}>
              {posting.roleTitle}
            </h1>
            <StatusBadge status={posting.status} />
          </div>
          <p className="page-sub">{posting.orgLabel}</p>

          <div className="card" style={{ marginBottom: 24 }}>
            <dl className="dl">
              <dt>Org</dt>
              <dd>{posting.orgLabel}</dd>
              <dt>Role</dt>
              <dd>{posting.roleTitle}</dd>
              <dt>Location</dt>
              <dd>{posting.locationLabel ?? "—"}</dd>
              <dt>Vacancy band</dt>
              <dd>{posting.vacancyBand}</dd>
              <dt>Status</dt>
              <dd>
                <StatusBadge status={posting.status} />
              </dd>
              <dt>Description</dt>
              <dd style={{ whiteSpace: "pre-wrap" }}>{posting.description ?? "—"}</dd>
              <dt>Created</dt>
              <dd>{fmt(posting.createdAt)}</dd>
              <dt>Updated</dt>
              <dd>{fmt(posting.updatedAt)}</dd>
              <dt>Closed</dt>
              <dd>{fmt(posting.closedAt)}</dd>
            </dl>
          </div>

          <PostingActions posting={posting} />
        </>
      ) : null}

      <div className="footer">
        Org/role/location/description are ops-entered free text and shown here —
        the PII rule applies to events/logs, not this internal register.
      </div>
    </>
  );
}
