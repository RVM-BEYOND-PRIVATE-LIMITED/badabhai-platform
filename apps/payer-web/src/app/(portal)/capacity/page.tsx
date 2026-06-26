import Link from "next/link";
import { getCapacity } from "../../../lib/payer-api";
import { requirePayer } from "../../../lib/auth";
import { hiringCapacityTiers } from "../../../lib/pricing-config";
import type { Capacity } from "../../../lib/contracts";
import { Badge, Card, StatTile, Toast } from "../../../components/ds";
import { RetryButton } from "../../../components/retry-button";
import { CapacityPanel } from "./capacity-panel";

export const dynamic = "force-dynamic";

/**
 * Capacity view (ADR-0019 Phase 1) + the QUOTA-PAUSE "Stream A" upgrade leg — DS2.3 re-skin
 * onto the BadaBhai Design System (VISUAL layer only; data + config + the live routes unchanged).
 *
 * The concurrent active-vacancy ALLOWANCE and the REAL active-plan count are LIVE from the
 * payer-authed `GET /payer/capacity` (XB-A: Bearer only, no payer_id). At-capacity is
 * derived from that REAL count (activeVacancies = active_plan_count >= allowance), so the
 * banner is faithful — it does NOT come from the seeded-mock posting rows. The per-posting
 * applicant-quota ROWS are still backend-seeded MOCK (no payer-authed create-posting / quota
 * endpoint yet) and are DISPLAY-only — see the page note + the payer-api.ts seam note. The
 * upgrade panel sends ONLY a tier CODE (XT5); price/allowance are DISPLAY-only from config and
 * render in mono tabular. All counts; NO raw worker/payer PII. The client never supplies a payer id.
 *
 * ENFORCEMENT IS INERT (ADR-0016): the concurrent-vacancy cap is faceless + mock-payments +
 * enforcement INERT by default (behind CAPACITY_ENFORCEMENT_ENABLED). Buying capacity is
 * RECORDED only — it does not yet block any posting. The copy below says so; it never implies
 * real enforcement or real money.
 */
export default async function CapacityPage() {
  const session = await requirePayer();
  const isAgency = session.role === "agent";
  const unit = isAgency ? "vacancies" : "postings";
  const unitOne = isAgency ? "vacancy" : "posting";
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
      <p className="capacity-back">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1 className="dash-title">Capacity</h1>
      <p className="dash-sub">
        How many {unit} you can run at once, and how many applicants each may disclose.
      </p>

      {error ? (
        <Card variant="outline" className="capacity-state">
          <Badge tone="warning" upper>
            Service unavailable
          </Badge>
          <p className="capacity-state__msg">
            We couldn&rsquo;t load your capacity right now. Please retry.
          </p>
          <RetryButton />
        </Card>
      ) : capacity ? (
        <>
          <div className="capacity-stats">
            <StatTile
              label={`Active ${unit}`}
              value={
                <span className="bb-mono">
                  {capacity.activeVacancies} / {capacity.activeVacancyAllowance}
                </span>
              }
              icon="stack"
              delta="Concurrent allowance (from the pricing config)."
              deltaDir="flat"
            />
            <StatTile
              label="Applicant quota used"
              value={
                <span className="bb-mono">
                  {capacity.applicantQuotaUsed} / {capacity.applicantQuotaTotal}
                </span>
              }
              icon="users-three"
              delta={<Link href="/postings">Top up applicant quota →</Link>}
              deltaDir="flat"
            />
          </div>

          {atCapacity ? (
            <Card variant="outline" className="capacity-alert">
              <Badge tone="warning" upper>
                At capacity
              </Badge>
              <p className="capacity-alert__msg">
                You are at capacity — new {unit} will be paused until you add capacity.
              </p>
            </Card>
          ) : null}

          <section className="capacity-section">
            <h2 className="capacity-section__title">Add capacity</h2>
            <p className="dash-sub">
              Your active-{unitOne} count above is{" "}
              <strong>live from the enforcement engine</strong> — it drives whether you are at
              capacity. Adding capacity raises your concurrent allowance and resumes any paused{" "}
              {unit}. Prices are <strong>mock</strong> — no real payment is taken.
            </p>
            <CapacityPanel tiers={tiers} />
            <div className="capacity-nudge">
              <Toast tone="neutral">
                <strong>Recorded only — nothing is blocked yet.</strong> Buying capacity is
                stored against your account; the concurrent-vacancy cap is not yet enforced, so it
                does not pause or block any {unitOne} today. Mock payments only — no money moves.
              </Toast>
            </div>
          </section>

          <section className="capacity-section">
            <h2 className="capacity-section__title">Per {unitOne}</h2>
            <p className="dash-sub">
              Your concurrent allowance and active count above are <strong>live</strong> from the
              backend enforcement engine. The per-{unitOne} rows below reflect{" "}
              <strong>backend-seeded plans only</strong> and do <strong>not</strong> drive that
              count — they will become live once the create-posting backend endpoint lands.
            </p>
            {capacity.postings.length === 0 ? (
              <Card variant="flat" className="capacity-empty">
                You haven&rsquo;t posted {isAgency ? "a vacancy" : "a job"} yet.{" "}
                <Link className="capacity-link" href="/postings/new">
                  {isAgency ? "Post your first vacancy" : "Post your first job"}
                </Link>
                .
              </Card>
            ) : (
              <Card padding="none" className="capacity-table-card">
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
                          <Link
                            className="capacity-link"
                            href={`/postings/${p.postingId}/applicants`}
                          >
                            {p.roleTitle}
                          </Link>
                        </td>
                        <td>
                          <Badge
                            tone={
                              p.status === "open"
                                ? "success"
                                : p.status === "paused"
                                  ? "warning"
                                  : "neutral"
                            }
                            upper
                          >
                            {p.status}
                          </Badge>
                        </td>
                        <td>{p.vacancyBand}</td>
                        <td className="bb-mono">{p.applicantsUsed}</td>
                        <td className="bb-mono">{p.applicantQuota}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </section>
        </>
      ) : null}
    </>
  );
}
