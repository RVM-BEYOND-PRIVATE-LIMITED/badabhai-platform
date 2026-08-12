import Link from "next/link";
import { getCapacity } from "../../../lib/payer-api";
import { requirePayer } from "../../../lib/auth";
import { getLiveCatalog } from "../../../lib/live-catalog";
import { hiringCapacityTiers } from "../../../lib/pricing-config";
import type { Capacity } from "../../../lib/contracts";
import { Badge, Card, StatTile } from "../../../components/ds";
import { CachedPricingNote } from "../../../components/cached-pricing-note";
import { RetryButton } from "../../../components/retry-button";
import { CapacityPanel } from "./capacity-panel";

export const dynamic = "force-dynamic";

/**
 * Capacity view (ADR-0019 Phase 1) + the QUOTA-PAUSE "Stream A" upgrade leg — composed onto
 * the UI-1 page spine (`page-back` / `page-head` / `stat-row` / `section` / `panel--table` /
 * `alert` / `state`). PRESENTATION ONLY: data + config + the live routes are unchanged.
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
  // LIVE catalog (D-6): the upgrade tiers/prices come from the API's active catalog —
  // an ops edit shows without a rebuild. Fetch failure ⇒ compile-time defaults + the
  // cached-pricing note (display-only; the tier is priced server-side at purchase, XT5).
  const { products, live } = await getLiveCatalog();
  const tiers = hiringCapacityTiers(products);

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
      <p className="page-back">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <div className="page-head">
        <div className="page-head__text">
          <h1 className="page-head__title">Capacity</h1>
          <p className="page-head__sub">
            How many {unit} you can run at once, and how many applicants each may disclose.
          </p>
        </div>
      </div>

      {error ? (
        <Card>
          <div className="state state--error">
            <span className="state__icon">
              <i className="ph ph-warning-circle" aria-hidden="true" />
            </span>
            <h2 className="state__title">Service unavailable</h2>
            <p className="state__body">
              We couldn&rsquo;t load your capacity right now. Nothing has changed — please retry.
            </p>
            <div className="state__actions">
              <RetryButton />
            </div>
          </div>
        </Card>
      ) : capacity ? (
        <>
          <div className="stat-row">
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
            <div className="alert alert--warning">
              <i className="ph ph-warning alert__icon" aria-hidden="true" />
              <div className="alert__text">
                <p className="alert__title">At capacity</p>
                <p className="alert__body">
                  You are at capacity — new {unit} will be paused until you add capacity.
                </p>
              </div>
            </div>
          ) : null}

          <section className="section">
            <div className="section__head">
              <h2 className="section__title">Add capacity</h2>
              <p className="section__sub">
                Your active-{unitOne} count above is{" "}
                <strong>live from the enforcement engine</strong> — it drives whether you are at
                capacity. Adding capacity raises your concurrent allowance and resumes any paused{" "}
                {unit}. Prices are <strong>mock</strong> — no real payment is taken.
              </p>
            </div>
            {!live ? <CachedPricingNote /> : null}
            <CapacityPanel tiers={tiers} />
            <div className="alert alert--info">
              <i className="ph ph-info alert__icon" aria-hidden="true" />
              <div className="alert__text">
                <p className="alert__title">Recorded only — nothing is blocked yet.</p>
                <p className="alert__body">
                  Buying capacity is stored against your account; the concurrent-vacancy cap is
                  not yet enforced, so it does not pause or block any {unitOne} today. Mock
                  payments only — no money moves.
                </p>
              </div>
            </div>
          </section>

          <section className="panel panel--table">
            <div className="panel__head">
              <h2 className="panel__title">Per {unitOne}</h2>
              <p className="panel__sub">
                Your concurrent allowance and active count above are <strong>live</strong> from
                the backend enforcement engine. The per-{unitOne} rows below reflect{" "}
                <strong>backend-seeded plans only</strong> and do <strong>not</strong> drive that
                count — they will become live once the create-posting backend endpoint lands.
              </p>
            </div>
            <div className="panel__body">
              {capacity.postings.length === 0 ? (
                <div className="state">
                  <span className="state__icon">
                    <i className="ph ph-briefcase" aria-hidden="true" />
                  </span>
                  <h3 className="state__title">No {unit} yet</h3>
                  <p className="state__body">
                    You haven&rsquo;t posted {isAgency ? "a vacancy" : "a job"} yet. Once you do,
                    its applicant quota shows here.
                  </p>
                  <div className="state__actions">
                    <Link className="bb-btn bb-btn--primary bb-btn--sm" href="/postings/new">
                      {isAgency ? "Post your first vacancy" : "Post your first job"}
                    </Link>
                  </div>
                </div>
              ) : (
                <div className="tablewrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Role</th>
                        <th>Status</th>
                        <th>Vacancies</th>
                        <th className="num">Applicants seen</th>
                        <th className="num">Applicant quota</th>
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
                          <td className="num">{p.applicantsUsed}</td>
                          <td className="num">{p.applicantQuota}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        </>
      ) : null}
    </>
  );
}
