import Link from "next/link";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { requirePayer } from "../../../lib/auth";
import { getOrgRole } from "../../../lib/auth/org-roles";
import { getCapacity } from "../../../lib/payer-api";
import { postingRoutes } from "../../../lib/posting-routes";
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
import { PageHeader } from "../../../components/page-header";
import { RetryButton } from "../../../components/retry-button";
import { CapacityPanel } from "../capacity/capacity-panel";

export const dynamic = "force-dynamic";

/** The per-posting table's heading — also the NAME of its scroll region (aria-labelledby). */
const QUOTA_TABLE_HEADING_ID = "plans-quota-table-title";

/**
 * Plans & capacity — the billing area: usage, the Hiring capacity tiers, each posting's
 * applicant quota, credit packs and posting plans.
 *
 * Naming (owner ruling 2026-10-01): one word per concept for both personas — "postings",
 * "Hiring capacity" (the concurrent allowance), "Applicant quota" (the per-posting cap),
 * "Credits". Doors follow their gates: a credit pack links to Credits for an OWNER only (a
 * recruiter's /credits is a 404), and an agency is never linked into the company posting
 * surface — its "New posting" opens the agency form.
 */
export default async function PlansPage() {
  const session = await requirePayer();
  const isAgency = session.role === "agent";
  const isOwner = getOrgRole(session) === "owner";
  const posting = postingRoutes(isAgency);

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

  // `.plans-page` only NAMESPACES this screen's layout rules (the "W3-B" block in
  // globals.css) — it carries no styling of its own.
  return (
    <div className="plans-page">
      <PageHeader
        title="Plans & capacity"
        description="Your current usage, available plans, and add-ons — all in one place."
      />

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
                <Icon name="warning-circle" />
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
            <div className="stat-row stat-row--kpi">
              <StatTile
                label="Active postings"
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
                icon={ACTION_ICON.users}
                caption={
                  // A company adds slots per posting on its Postings page. An agency has no
                  // slot control to send it to, so its caption is a fact, not a link.
                  isAgency ? (
                    "Each posting has its own quota."
                  ) : (
                    <Link href="/postings">
                      Add applicant slots in Postings <Icon name={ACTION_ICON.next} />
                    </Link>
                  )
                }
              />
            </div>

            {atCapacity ? (
              <div className="alert alert--warning">
                <Icon name="warning" className="alert__icon" />
                <div className="alert__text">
                  <p className="alert__title">At capacity</p>
                  <p className="alert__body">
                    You are at capacity — new postings will be paused until you add capacity.
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
          <div className="section__text">
            <h2 className="section__title">Hiring capacity</h2>
            <p className="section__sub">
              Increase how many concurrent postings you can run at once. Your active count above
              is <strong>live from the enforcement engine</strong>. Prices are{" "}
              <strong>mock</strong> — no real payment is taken.
            </p>
          </div>
        </div>
        {tiers.length === 0 ? (
          <div className="state">
            <span className="state__icon">
              <Icon name="stack" />
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
          <Icon name="info" className="alert__icon" />
          <div className="alert__text">
            <p className="alert__title">Recorded only — nothing is blocked yet.</p>
            <p className="alert__body">
              Buying capacity is stored against your account; the concurrent-posting cap is not
              yet enforced, so it does not pause or block any posting today. Mock payments only
              — no money moves.
            </p>
          </div>
        </div>
      </section>

      {/* ── Per-posting applicant quota table ── */}
      {capacity ? (
        <section className="panel panel--table">
          <div className="panel__head">
            <div className="panel__text">
              <h2 className="panel__title" id={QUOTA_TABLE_HEADING_ID}>
                Applicant quota per posting
              </h2>
              <p className="panel__sub">
                Your concurrent allowance and active count above are <strong>live</strong> from
                the backend enforcement engine. The per-posting rows reflect backend-seeded
                plans only.
              </p>
            </div>
          </div>
          <div className="panel__body">
            {capacity.postings.length > 0 ? (
              <div
                className="tablewrap"
                tabIndex={0}
                role="region"
                aria-labelledby={QUOTA_TABLE_HEADING_ID}
              >
                <table className="table">
                  <thead>
                    <tr>
                      <th>Role</th>
                      <th>Status</th>
                      <th>Openings</th>
                      <th className="num">Applicants seen</th>
                      <th className="num">Applicant quota</th>
                    </tr>
                  </thead>
                  <tbody>
                    {capacity.postings.map((p) => (
                      <tr key={p.postingId}>
                        <td>
                          {/* These rows are company postings; an agency is never linked into
                              the company posting surface, so for an agent the role is text. */}
                          {isAgency ? (
                            p.roleTitle
                          ) : (
                            <Link
                              className="capacity-link"
                              href={`/postings/${p.postingId}/applicants`}
                            >
                              {p.roleTitle}
                            </Link>
                          )}
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
                  <Icon name={ACTION_ICON.posting} />
                </span>
                <h3 className="state__title">No postings yet</h3>
                <p className="state__body">
                  You haven&rsquo;t published a posting yet. Once you do, its applicant quota
                  shows here.
                </p>
                {posting ? (
                  <div className="state__actions">
                    <Link className="bb-btn bb-btn--primary" href={posting.create}>
                      <Icon name={ACTION_ICON.create} />
                      <span>New posting</span>
                    </Link>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </section>
      ) : null}

      {/* ── Credit packs ── */}
      <section className="section">
        <div className="section__head">
          <div className="section__text">
            <h2 className="section__title">Credits</h2>
            <p className="section__sub">
              {isOwner ? "Buy credits" : "An account owner buys credits"} to unlock worker contact
              details. 1 credit = 1 contact unlock.
            </p>
          </div>
        </div>
        {packs.length === 0 ? (
          <div className="state">
            <span className="state__icon">
              <Icon name={ACTION_ICON.credits} />
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
                    inside an <a> — one control, one accessible role. Owner-only: Credits is
                    `requireOwner()`, so a recruiter is never sent to its 404. */}
                {isOwner ? (
                  <Link className="bb-btn bb-btn--primary bb-btn--block" href="/credits">
                    <Icon name={ACTION_ICON.credits} />
                    <span>Buy credits</span>
                  </Link>
                ) : null}
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* ── Posting plans ── */}
      <section className="section">
        <div className="section__head">
          <div className="section__text">
            <h2 className="section__title">Posting plans</h2>
            <p className="section__sub">Postings are free through launch.</p>
          </div>
        </div>
        {postingTiers.length === 0 ? (
          <div className="state">
            <span className="state__icon">
              <Icon name={ACTION_ICON.posting} />
            </span>
            <h3 className="state__title">No posting plans on offer</h3>
            <p className="state__body">
              No plan is listed right now — this usually means the price list is being updated.
              Any posting you have already published stays live; check back shortly.
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
                {posting ? (
                  <Link className="bb-btn bb-btn--primary bb-btn--block" href={posting.create}>
                    <Icon name={ACTION_ICON.create} />
                    <span>New posting</span>
                  </Link>
                ) : null}
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* ── Mock payments disclaimer ── */}
      <div className="alert alert--info">
        <Icon name="info" className="alert__icon" />
        <div className="alert__text">
          <p className="alert__title">Mock payments</p>
          <p className="alert__body">
            No real money is taken. Prices shown are mock figures for the staging preview.
          </p>
        </div>
      </div>
    </div>
  );
}
