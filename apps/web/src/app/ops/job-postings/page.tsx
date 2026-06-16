import Link from "next/link";
import type { JobPostingStatus } from "@badabhai/types";
import { listJobPostings, type JobPostingRow } from "@/lib/api";
import { StatusBadge } from "@/components/status-badge";
import { StatusFilter } from "./status-filter";

// Live ops data — always fetched fresh from the API at request time.
export const dynamic = "force-dynamic";

const VALID_STATUSES: JobPostingStatus[] = ["draft", "open", "closed"];

/**
 * Job postings list — wired to GET /job-postings (newest first), with an
 * optional `?status=` filter. ADR-0010: ops-created, vacancy-banded,
 * stored-only. Org/role/location text shown here was typed by ops and lives only
 * on the row — that's distinct from the PII rule (events/logs) and the faceless
 * Reach feed.
 */
export default async function JobPostingsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status: rawStatus } = await searchParams;
  const status =
    rawStatus && (VALID_STATUSES as string[]).includes(rawStatus)
      ? (rawStatus as JobPostingStatus)
      : undefined;

  let postings: JobPostingRow[] = [];
  let error: string | null = null;
  try {
    postings = await listJobPostings(status);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <>
      <div className="btn-row" style={{ justifyContent: "space-between" }}>
        <h1 className="page-title">Job Postings</h1>
        <Link className="btn" href="/ops/job-postings/new">
          + New posting
        </Link>
      </div>
      <p className="page-sub">
        Ops-created job postings (newest first). Vacancy is banded, not a count.
      </p>

      <StatusFilter />

      {error ? (
        <p className="page-sub">
          <span className="badge">API unavailable</span> {error}
        </p>
      ) : postings.length === 0 ? (
        <p className="page-sub">No job postings yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Org</th>
              <th>Role</th>
              <th>Location</th>
              <th>Vacancy band</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {postings.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link href={`/ops/job-postings/${p.id}`}>{p.orgLabel}</Link>
                </td>
                <td>{p.roleTitle}</td>
                <td>{p.locationLabel ?? "—"}</td>
                <td>{p.vacancyBand}</td>
                <td>
                  <StatusBadge status={p.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="footer">
        Internal register. Org/role/location text is ops-entered and shown here —
        the PII rule applies to events/logs, not this view.
      </div>
    </>
  );
}
