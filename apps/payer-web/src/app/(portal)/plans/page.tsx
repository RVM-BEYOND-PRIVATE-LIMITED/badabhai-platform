import Link from "next/link";
import { redirect } from "next/navigation";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { requirePayer } from "../../../lib/auth";
import { getCapacity } from "../../../lib/payer-api";
import { COMPANY_POSTING_ROUTES } from "../../../lib/posting-routes";
import { HIRING_CAPACITY_ANCHOR } from "../../../lib/billing-routes";
import { getLiveCatalog } from "../../../lib/live-catalog";
import {
  hiringCapacityTiers,
  offeredCreditPacks,
  postingPaidTiers,
} from "../../../lib/pricing-config";
import type { Capacity } from "../../../lib/contracts";
import { Badge, Card, StatTile } from "../../../components/ds";
import { CachedPricingNote } from "../../../components/cached-pricing-note";
import { priceFigure } from "../../../components/price-figure";
import { PageHeader } from "../../../components/page-header";
import { RetryButton } from "../../../components/retry-button";
import { CapacityPanel } from "../capacity/capacity-panel";

export const dynamic = "force-dynamic";

/** The per-posting table's heading — also the NAME of its scroll region (aria-labelledby). */
const QUOTA_TABLE_HEADING_ID = "plans-quota-table-title";

/**
 * Plans & capacity — a COMPANY's billing area: usage, the Hiring capacity tiers, each posting's
 * applicant quota, credit packs and posting plans.
 *
 * COMPANY-ONLY (2026-10-01, a consequence of ruling 2): everything sold here is an entitlement
 * on COMPANY postings (`job_postings`: concurrent capacity, per-posting applicant quota, posting
 * plans), and an agency posts agency jobs only. An agent is sent to the dashboard before any
 * read; the agency rail and dashboard do not offer this page. Credits (/credits) stays for both
 * personas.
 *
 * Naming: one word per concept — "postings", "Hiring capacity" (the concurrent allowance),
 * "Applicant quota" (the per-posting cap), "Credits". One door per destination: every member
 * (Owner or Recruiter — any member can buy, owner ruling 2026-10-07) reaches Credits from the rail
 * (Billing) and the header chip on every page, so the credit packs carry no door and the Credits
 * section adds none — it names the Credits page instead (F15: per-card buttons were one link N
 * times, and a section "Buy credits" beside the chip was two). ONE "New posting". A posting's role
 * title opens the POSTING (F12): a title always opens the details, and the details carry the
 * "Applicants" action.
 *
 * No "mock" / "staging preview" copy anywhere on the page or its capacity panel (owner ruling
 * 2026-10-07, F35: "mock wording is not needing on plans and credit") — and no replacement
 * disclaimer. The purchase behaviour is unchanged.
 */
export default async function PlansPage() {
  const session = await requirePayer();
  if (session.role === "agent") redirect("/dashboard");

  // Every price here is what the tier is charged (#2085 — the catalog's `prices[]`), so a tile
  // and the purchase it leads to can never disagree.
  const catalog = await getLiveCatalog();
  const { live } = catalog;
  const packs = offeredCreditPacks(catalog);
  const tiers = hiringCapacityTiers(catalog);
  const postingTiers = postingPaidTiers(catalog);

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
                  // Slots are added per posting, on the Postings page.
                  <Link href="/postings">
                    Add applicant slots in Postings <Icon name={ACTION_ICON.next} />
                  </Link>
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

      {/* ── Capacity tiers ── (the target of /capacity → /plans#hiring-capacity) */}
      <section className="section anchor-target" id={HIRING_CAPACITY_ANCHOR}>
        <div className="section__head">
          <div className="section__text">
            <h2 className="section__title">Hiring capacity</h2>
            <p className="section__sub">
              Increase how many concurrent postings you can run at once. Your active count above
              is <strong>live from the enforcement engine</strong>.
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
          // The allowance this page already read: a tier at or below it would grant nothing
          // (the larger allowance is kept), so the panel shows it as included. A failed read
          // hands down null — nothing is ruled out.
          <CapacityPanel
            tiers={tiers}
            currentAllowance={capacity?.activeVacancyAllowance ?? null}
          />
        )}
        <div className="alert alert--info">
          <Icon name="info" className="alert__icon" />
          <div className="alert__text">
            <p className="alert__title">Recorded only — nothing is blocked yet.</p>
            <p className="alert__body">
              Buying capacity is stored against your account; the concurrent-posting cap is not
              yet enforced, so it does not pause or block any posting today.
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
                          <Link className="capacity-link" href={`/postings/${p.postingId}`}>
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
                  <Icon name={ACTION_ICON.posting} />
                </span>
                <h3 className="state__title">No postings yet</h3>
                {/* The page's one "New posting" is in Posting plans below. */}
                <p className="state__body">
                  You haven&rsquo;t published a posting yet. Once you do, its applicant quota
                  shows here.
                </p>
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
            {/* No door here (F15): every member reaches Credits from the rail (Billing) and the
                header chip, so the copy names the PAGE — never the chip, which hides when its own
                read fails. */}
            <p className="section__sub">
              Buy credits on the Credits page, under Billing, to unlock worker contact details. 1
              credit = 1 contact unlock.
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
                <div className="plan-card__price bb-mono">{priceFigure(p)}</div>
                <p className="plan-card__detail">
                  <span className="bb-mono">{p.credits}</span> credits
                </p>
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
          {/* The page's ONE "New posting" (the plan cards used to carry one each). */}
          <div className="section__actions">
            <Link className="bb-btn bb-btn--secondary" href={COMPANY_POSTING_ROUTES.create}>
              <Icon name={ACTION_ICON.create} />
              <span>New posting</span>
            </Link>
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
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
