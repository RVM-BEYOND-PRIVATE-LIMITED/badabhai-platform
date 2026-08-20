import Link from "next/link";
import { requirePayer } from "../../../lib/auth";
import { getCapacity } from "../../../lib/payer-api";
import { getLiveCatalog } from "../../../lib/live-catalog";
import {
  hiringCapacityTiers,
  offeredCreditPacks,
  postingPaidTiers,
} from "../../../lib/pricing-config";
import { formatInr } from "../../../lib/format";
import type { Capacity } from "../../../lib/contracts";
import { Badge, Card, StatTile } from "../../../components/ds";
import { CachedPricingNote } from "../../../components/cached-pricing-note";
import { RetryButton } from "../../../components/retry-button";
import { CapacityPanel } from "../capacity/capacity-panel";

export const dynamic = "force-dynamic";

export default async function PlansPage() {
  const session = await requirePayer();
  const isAgency = session.role === "agent";
  const unit = isAgency ? "vacancies" : "postings";
  const unitOne = isAgency ? "vacancy" : "posting";

  const { products, live } = await getLiveCatalog();
  const packs = offeredCreditPacks(products);
  const tiers = hiringCapacityTiers(products);
  const postingTiers = postingPaidTiers(products);

  let capacity: Capacity | null = null;
  let capacityError: string | null = null;
  try {
    capacity = await getCapacity();
  } catch (e) {
    capacityError = e instanceof Error ? e.message : String(e);
  }

  const atCapacity =
    capacity !== null && capacity.activeVacancies >= capacity.activeVacancyAllowance;

  return (
    <>
      <p className="page-back">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <div className="page-head">
        <div className="page-head__text">
          <h1 className="page-head__title">Plans &amp; Capacity</h1>
          <p className="page-head__sub">
            Your current usage, available plans, and add-ons — all in one place.
          </p>
        </div>
      </div>

      {!live ? <CachedPricingNote /> : null}

      {/* ── Capacity overview ── */}
      <section className="section">
        <div className="section__head">
          <h2 className="section__title">Your current capacity</h2>
        </div>
        {capacityError ? (
          <Card>
            <div className="state state--error">
              <span className="state__icon">
                <i className="ph ph-warning-circle" aria-hidden="true" />
              </span>
              <h3 className="state__title">Service unavailable</h3>
              <p className="state__body">
                We couldn&rsquo;t load your capacity right now. Nothing has changed — please
                retry.
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
                caption="Concurrent allowance (from the pricing config)."
              />
              <StatTile
                label="Applicant quota used"
                value={
                  <span className="bb-mono">
                    {capacity.applicantQuotaUsed} / {capacity.applicantQuotaTotal}
                  </span>
                }
                icon="users-three"
                caption={<Link href="/postings">Top up applicant quota →</Link>}
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
          </>
        ) : null}
      </section>

      {/* ── Capacity tiers ── */}
      <section className="section">
        <div className="section__head">
          <h2 className="section__title">Hiring Capacity</h2>
          <p className="section__sub">
            Increase how many concurrent {unitOne}s you can run at once. Your active count above
            is <strong>live from the enforcement engine</strong>. Prices are <strong>mock</strong>{" "}
            — no real payment is taken.
          </p>
        </div>
        {tiers.length === 0 ? (
          <div className="state">
            <span className="state__icon">
              <i className="ph ph-stack" aria-hidden="true" />
            </span>
            <h3 className="state__title">No capacity tiers on offer</h3>
            <p className="state__body">
              There is nothing to buy right now — this usually means the price list is being
              updated. Your current allowance is unaffected; check back shortly.
            </p>
          </div>
        ) : (
          <CapacityPanel tiers={tiers} />
        )}
        <div className="alert alert--info">
          <i className="ph ph-info alert__icon" aria-hidden="true" />
          <div className="alert__text">
            <p className="alert__title">Recorded only — nothing is blocked yet.</p>
            <p className="alert__body">
              Buying capacity is stored against your account; the concurrent-vacancy cap is not
              yet enforced, so it does not pause or block any {unitOne} today. Mock payments only
              — no money moves.
            </p>
          </div>
        </div>
      </section>

      {/* ── Per-posting applicant quota table ── */}
      {capacity ? (
        <section className="panel panel--table">
          <div className="panel__head">
            <h2 className="panel__title">Per {unitOne} applicant quota</h2>
            <p className="panel__sub">
              Your concurrent allowance and active count above are <strong>live</strong> from the
              backend enforcement engine. The per-{unitOne} rows reflect backend-seeded plans
              only.
            </p>
          </div>
          <div className="panel__body">
            {capacity.postings.length > 0 ? (
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
            ) : (
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
            )}
          </div>
        </section>
      ) : null}

      {/* ── Credit packs ── */}
      <section className="section">
        <div className="section__head">
          <h2 className="section__title">Contact Unlock Credits</h2>
          <p className="section__sub">
            Buy credits to unlock worker contact details. 1 credit = 1 contact unlock.
          </p>
        </div>
        {packs.length === 0 ? (
          <div className="state">
            <span className="state__icon">
              <i className="ph ph-wallet" aria-hidden="true" />
            </span>
            <h3 className="state__title">No credit packs on offer</h3>
            <p className="state__body">
              There is nothing to buy right now — this usually means the price list is being
              updated. Your existing balance is unaffected; check back shortly.
            </p>
          </div>
        ) : (
          <div className="plans-grid">
            {packs.map((p) => (
              <Card key={p.code} className="plan-card">
                <div className="plan-card__head">
                  <span className="plan-card__name">{p.code.replace(/_/g, " ")}</span>
                </div>
                <div className="plan-card__price bb-mono">{formatInr(p.priceInr)}</div>
                <p className="plan-card__detail">
                  <span className="bb-mono">{p.credits}</span> credits
                </p>
                {/* The action is the LINK itself (`bb-btn` on the anchor), not a <button>
                    inside an <a> — one control, one accessible role. */}
                <Link className="bb-btn bb-btn--primary bb-btn--block" href="/credits">
                  Buy
                </Link>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* ── Posting plans ── */}
      <section className="section">
        <div className="section__head">
          <h2 className="section__title">{isAgency ? "Vacancy" : "Job"} Posting Plans</h2>
          <p className="section__sub">
            {isAgency ? "Vacancies" : "Postings"} are free through launch.
          </p>
        </div>
        {postingTiers.length === 0 ? (
          <div className="state">
            <span className="state__icon">
              <i className="ph ph-briefcase" aria-hidden="true" />
            </span>
            <h3 className="state__title">No posting plans on offer</h3>
            <p className="state__body">
              No plan is listed right now — this usually means the price list is being updated.
              Any {unitOne} you have already posted stays live; check back shortly.
            </p>
          </div>
        ) : (
          <div className="plans-grid">
            {postingTiers.map((t) => (
              <Card key={t.code} className="plan-card">
                <div className="plan-card__head">
                  <span className="plan-card__name">{t.code.replace(/_/g, " ")}</span>
                </div>
                <div className="plan-card__price bb-mono">Free</div>
                <p className="plan-card__detail">Valid for {t.validityDays} days</p>
                <Link className="bb-btn bb-btn--primary bb-btn--block" href="/postings/new">
                  Post now
                </Link>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* ── Mock payments disclaimer ── */}
      <div className="alert alert--info">
        <i className="ph ph-info alert__icon" aria-hidden="true" />
        <div className="alert__text">
          <p className="alert__title">Mock payments</p>
          <p className="alert__body">
            No real money is taken. Prices shown are mock figures for the staging preview.
          </p>
        </div>
      </div>
    </>
  );
}
