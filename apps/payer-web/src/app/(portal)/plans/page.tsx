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
import { Badge, Button, Card, StatTile, Toast } from "../../../components/ds";
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
      <p className="capacity-back">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1 className="dash-title">Plans &amp; Capacity</h1>
      <p className="dash-sub">
        Your current usage, available plans, and add-ons — all in one place.
      </p>

      {!live ? <CachedPricingNote /> : null}

      {/* ── Capacity overview ── */}
      <section className="plans-section">
        <h2 className="plans-section__title">Your current capacity</h2>
        {capacityError ? (
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
          </>
        ) : null}
      </section>

      {/* ── Capacity tiers ── */}
      <section className="plans-section">
        <h2 className="plans-section__title">Hiring Capacity</h2>
        <p className="plans-section__sub">
          Increase how many concurrent {unitOne}s you can run at once. Your active count above is{" "}
          <strong>live from the enforcement engine</strong>. Prices are <strong>mock</strong> — no
          real payment is taken.
        </p>
        {tiers.length === 0 ? (
          <Card variant="flat" className="plans-empty">
            No capacity tiers are currently offered.
          </Card>
        ) : (
          <CapacityPanel tiers={tiers} />
        )}
        <div className="plans-nudge">
          <Toast tone="neutral">
            <strong>Recorded only — nothing is blocked yet.</strong> Buying capacity is stored
            against your account; the concurrent-vacancy cap is not yet enforced, so it does not
            pause or block any {unitOne} today. Mock payments only — no money moves.
          </Toast>
        </div>
      </section>

      {/* ── Per-posting applicant quota table ── */}
      {capacity && capacity.postings.length > 0 ? (
        <section className="plans-section">
          <h2 className="plans-section__title">Per {unitOne} applicant quota</h2>
          <p className="plans-section__sub">
            Your concurrent allowance and active count above are <strong>live</strong> from the
            backend enforcement engine. The per-{unitOne} rows reflect backend-seeded plans only.
          </p>
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
                      <Link className="capacity-link" href={`/postings/${p.postingId}/applicants`}>
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
        </section>
      ) : capacity && capacity.postings.length === 0 ? (
        <section className="plans-section">
          <h2 className="plans-section__title">Per {unitOne} applicant quota</h2>
          <Card variant="flat" className="plans-empty">
            You haven&rsquo;t posted {isAgency ? "a vacancy" : "a job"} yet.{" "}
            <Link className="capacity-link" href="/postings/new">
              {isAgency ? "Post your first vacancy" : "Post your first job"}
            </Link>
            .
          </Card>
        </section>
      ) : null}

      {/* ── Credit packs ── */}
      <section className="plans-section">
        <h2 className="plans-section__title">Contact Unlock Credits</h2>
        <p className="plans-section__sub">
          Buy credits to unlock worker contact details. 1 credit = 1 contact unlock.
        </p>
        {packs.length === 0 ? (
          <Card variant="flat" className="plans-empty">
            No credit packs are currently offered.
          </Card>
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
                <Link href="/credits" className="plan-card__action">
                  <Button variant="primary" block>Buy</Button>
                </Link>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* ── Posting plans ── */}
      <section className="plans-section">
        <h2 className="plans-section__title">{isAgency ? "Vacancy" : "Job"} Posting Plans</h2>
        <p className="plans-section__sub">
          {isAgency ? "Vacancies" : "Postings"} are free through launch.
        </p>
        {postingTiers.length === 0 ? (
          <Card variant="flat" className="plans-empty">
            No posting plans are currently offered.
          </Card>
        ) : (
          <div className="plans-grid">
            {postingTiers.map((t) => (
              <Card key={t.code} className="plan-card">
                <div className="plan-card__head">
                  <span className="plan-card__name">{t.code.replace(/_/g, " ")}</span>
                </div>
                <div className="plan-card__price bb-mono">Free</div>
                <p className="plan-card__detail">Valid for {t.validityDays} days</p>
                <Link href="/postings/new" className="plan-card__action">
                  <Button variant="primary" block>Post now</Button>
                </Link>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* ── Mock payments disclaimer ── */}
      <section className="plans-section">
        <Card variant="flat" className="plans-nudge">
          <Badge tone="neutral" upper>Mock payments</Badge>
          <p className="plans-nudge__msg">
            No real money is taken. Prices shown are mock figures for the staging preview.
          </p>
        </Card>
      </section>
    </>
  );
}
