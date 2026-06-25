import Link from "next/link";
import { getCapacity } from "../../../lib/payer-api";
import { requirePayer } from "../../../lib/auth";
import { hiringCapacityTiers } from "../../../lib/pricing-config";
import type { Capacity } from "../../../lib/contracts";
import { RetryButton } from "../../../components/retry-button";
import { CapacityPanel } from "./capacity-panel";

export const dynamic = "force-dynamic";

/**
 * Capacity view (ADR-0019 Phase 1) + the QUOTA-PAUSE "Stream A" upgrade leg.
 *
 * The concurrent active-vacancy ALLOWANCE and the REAL active-plan count are LIVE from the
 * payer-authed `GET /payer/capacity` (XB-A: Bearer only, no payer_id). At-capacity is
 * derived from that REAL count (activeVacancies = active_plan_count >= allowance), so the
 * banner is faithful — it does NOT come from the seeded-mock posting rows. The per-posting
 * applicant-quota ROWS are still backend-seeded MOCK (no payer-authed create-posting / quota
 * endpoint yet) and are DISPLAY-only — see the page note + the payer-api.ts seam note. The
 * upgrade panel sends ONLY a tier CODE (XT5); price/allowance are DISPLAY-only from config.
 * All counts; NO raw worker/payer PII. The client never supplies a payer id.
 */
export default async function CapacityPage() {
  const session = await requirePayer();
  const isAgency = session.role === "agent";
  const tiers = hiringCapacityTiers();

  let capacity: Capacity | null = null;
  let error: string | null = null;
  try {
    capacity = await getCapacity();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // At-capacity derives from the REAL enforcement-engine count, never the mock rows.
  const atCapacity =
    capacity !== null && capacity.activeVacancies >= capacity.activeVacancyAllowance;

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
          capacity right now. Please retry. <RetryButton />
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

          {atCapacity ? (
            <p className="page-sub">
              <span className="badge badge-warn">At capacity</span> You are at capacity — new{" "}
              {isAgency ? "vacancies" : "postings"} will be paused until you add capacity.
            </p>
          ) : null}

          <section className="section">
            <h2>Add capacity</h2>
            <div className="note">
              Your active-{isAgency ? "vacancy" : "posting"} count above is{" "}
              <strong>live from the enforcement engine</strong> — it drives whether you are at
              capacity. Upgrading raises your concurrent allowance and resumes any paused{" "}
              {isAgency ? "vacancies" : "postings"}. Prices are <strong>mock</strong> — no real
              payment is taken.
            </div>
            <CapacityPanel tiers={tiers} />
          </section>

          <section className="section">
            <h2>Per {isAgency ? "vacancy" : "posting"}</h2>
            <div className="note">
              Your concurrent allowance and active count above are <strong>live</strong> from the
              backend enforcement engine. The per-{isAgency ? "vacancy" : "posting"} rows below
              reflect <strong>backend-seeded plans only</strong> and do <strong>not</strong> drive
              that count — they will become live once the create-posting backend endpoint lands.
            </div>
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
