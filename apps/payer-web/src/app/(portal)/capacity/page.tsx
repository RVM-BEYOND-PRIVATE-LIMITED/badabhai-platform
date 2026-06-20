import Link from "next/link";
import { getCapacity } from "../../../lib/payer-api";
import { requirePayer } from "../../../lib/auth";
import type { Capacity } from "../../../lib/contracts";

export const dynamic = "force-dynamic";

/**
 * Capacity view (ADR-0019 Phase 1 — WAITING mock, READ-ONLY).
 *
 * Shows the payer's concurrent active-vacancy allowance (ADR-0016, config-derived)
 * and per-posting applicant-quota usage (quota purchased vs profiles disclosed). All
 * counts; NO raw worker/payer PII. XB-A: the seam derives everything from the
 * server-held session's postings — the client never supplies a payer id. The
 * `capacity.controller` is InternalServiceGuard, so this is a mock shim until a
 * payer-authed `GET /payer/capacity` lands (see payer-api.ts ESCALATE note).
 */
export default async function CapacityPage() {
  const session = await requirePayer();
  const isAgency = session.role === "agent";

  let capacity: Capacity | null = null;
  let error: string | null = null;
  try {
    capacity = await getCapacity();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <>
      <p className="page-sub">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1 className="page-title">Capacity</h1>
      <p className="page-sub">
        How many {isAgency ? "vacancies" : "postings"} you can run at once, and how many applicants
        each may disclose.
      </p>

      {error ? (
        <p className="page-sub">
          <span className="badge badge-warn">Service unavailable</span> We couldn&rsquo;t load your
          capacity right now. Please retry.
        </p>
      ) : capacity ? (
        <>
          <div className="cards">
            <div className="card">
              <h3>Active {isAgency ? "vacancies" : "postings"}</h3>
              <div className="big">
                {capacity.activeVacancies} / {capacity.activeVacancyAllowance}
              </div>
              <p>Concurrent allowance (from the pricing config).</p>
            </div>
            <div className="card">
              <h3>Applicant quota used</h3>
              <div className="big">
                {capacity.applicantQuotaUsed} / {capacity.applicantQuotaTotal}
              </div>
              <p>
                <Link href="/postings">Top up applicant quota →</Link>
              </p>
            </div>
          </div>

          <section className="section">
            <h2>Per {isAgency ? "vacancy" : "posting"}</h2>
            {capacity.postings.length === 0 ? (
              <div className="empty">
                You haven&rsquo;t posted {isAgency ? "a vacancy" : "a job"} yet.{" "}
                <Link href="/postings/new">
                  {isAgency ? "Post your first vacancy" : "Post your first job"}
                </Link>
                .
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Vacancies</th>
                    <th>Applicants seen</th>
                    <th>Applicant quota</th>
                  </tr>
                </thead>
                <tbody>
                  {capacity.postings.map((p) => (
                    <tr key={p.postingId}>
                      <td>
                        <Link href={`/postings/${p.postingId}/applicants`}>{p.roleTitle}</Link>
                      </td>
                      <td>
                        <span
                          className={
                            p.status === "open"
                              ? "badge badge-ok"
                              : p.status === "paused"
                                ? "badge badge-warn"
                                : "badge"
                          }
                        >
                          {p.status}
                        </span>
                      </td>
                      <td>{p.vacancyBand}</td>
                      <td className="mono">{p.applicantsUsed}</td>
                      <td className="mono">{p.applicantQuota}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      ) : null}
    </>
  );
}
