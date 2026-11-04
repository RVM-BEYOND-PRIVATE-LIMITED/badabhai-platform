import { redirect } from "next/navigation";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { requirePayer } from "../../../lib/auth";
import { getCapacity, getCredits } from "../../../lib/payer-api";
import { HIRING_CAPACITY_ANCHOR } from "../../../lib/billing-routes";
import { getLiveCatalog } from "../../../lib/live-catalog";
import {
  hiringCapacityTiers,
  offeredCreditPacks,
  postingPaidTiers,
} from "../../../lib/pricing-config";
import type { Capacity } from "../../../lib/contracts";
import { Badge, Card } from "../../../components/ds";
import { CachedPricingNote } from "../../../components/cached-pricing-note";
import { formatInr } from "../../../lib/format";
import { PageHeader } from "../../../components/page-header";
import { PortalLink } from "../../../components/portal-link";
import { RetryButton } from "../../../components/retry-button";
import { CapacityPanel } from "../capacity/capacity-panel";

export const dynamic = "force-dynamic";

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

  let credits: number | null = null;
  try {
    credits = (await getCredits()).balance;
  } catch {
    credits = null;
  }

  // `.plans-page` only NAMESPACES this screen's layout rules (the "W3-B" block in
  // globals.css) — it carries no styling of its own.
  const allowancePct =
    capacity !== null && capacity.activeVacancyAllowance > 0
      ? Math.min(
          100,
          Math.round(
            (capacity.activeVacancies / capacity.activeVacancyAllowance) * 100,
          ),
        )
      : 0;

  return (
    <div className="plans-page">
      <PageHeader
        title="Plans & capacity"
        description="Your current usage, available plans, and add-ons — all in one place."
        badge={<span className="plans-live">LIVE TIER</span>}
        actionsSlot={
          <span className="plans-enforced">
            <Icon name="shield-check" /> Backend enforcement live
          </span>
        }
      />

      {!live ? <CachedPricingNote /> : null}

      {capacityError ? (
        <Card>
          <div className="state state--error">
            <span className="state__icon">
              <Icon name="warning-circle" />
            </span>
            <h3 className="state__title">Service unavailable</h3>
            <p className="state__body">
              We couldn&rsquo;t load your capacity right now. Nothing has changed — please retry.
            </p>
            <div className="state__actions">
              <RetryButton />
            </div>
          </div>
        </Card>
      ) : capacity ? (
        <div className="plans-stats">
          <section className="plans-stat">
            <div className="plans-stat__head">
              <span>ACTIVE POSTINGS</span>
              <span className="plans-stat__ico">
                <Icon name="stack" />
              </span>
            </div>
            <p className="plans-stat__value bb-mono">
              {capacity.activeVacancies} / {capacity.activeVacancyAllowance}
            </p>
            <p className="plans-stat__cap">allowance</p>
            <div className="plans-stat__bar" aria-hidden="true">
              <span style={{ width: `${allowancePct}%` }} />
            </div>
            <p className="plans-stat__foot">
              Concurrent count from config <span>{allowancePct}% used</span>
            </p>
          </section>

          <section className="plans-stat">
            <div className="plans-stat__head">
              <span>APPLICANT QUOTA USED</span>
              <span className="plans-stat__ico plans-stat__ico--green">
                <Icon name="users-three" />
              </span>
            </div>
            <p className="plans-stat__value bb-mono">
              {capacity.applicantQuotaUsed} / {capacity.applicantQuotaTotal}
            </p>
            <p className="plans-stat__cap">slots</p>
            <p className="plans-stat__foot">
              <PortalLink className="plans-stat__link" href="/postings" pendingLabel="Postings">
                Add applicant slots in Postings <Icon name={ACTION_ICON.next} />
              </PortalLink>
            </p>
          </section>

          <section className="plans-stat">
            <div className="plans-stat__head">
              <span>AVAILABLE CREDITS</span>
              <span className="plans-stat__ico plans-stat__ico--amber">
                <Icon name={ACTION_ICON.credits} />
              </span>
            </div>
            <p className="plans-stat__value bb-mono">{credits ?? "—"}</p>
            <p className="plans-stat__cap">Contact credits</p>
            <p className="plans-stat__foot">
              1 credit = 1 contact unlock
              <PortalLink
                className="plans-stat__link"
                href="/credits"
                pendingLabel="Credits"
              >
                Recharge <Icon name={ACTION_ICON.next} />
              </PortalLink>
            </p>
          </section>
        </div>
      ) : null}

      <div className="plans-columns">
        <div className="plans-col">
          <section className="plans-card anchor-target" id={HIRING_CAPACITY_ANCHOR}>
            <div className="plans-card__head">
              <div>
                <h2 className="plans-card__title">Hiring Capacity Upgrades</h2>
                <p className="plans-card__sub">
                  Increase how many concurrent postings you can run at once.
                </p>
              </div>
              <span className="plans-pill plans-pill--green">Realtime Auto-scaling</span>
            </div>
            <div className="plans-card__body">
              {tiers.length === 0 ? (
                <div className="state">
                  <span className="state__icon">
                    <Icon name="stack" />
                  </span>
                  <h3 className="state__title">No capacity tiers on offer</h3>
                  <p className="state__body">
                    There is nothing to buy right now — your current allowance is unaffected.
                  </p>
                </div>
              ) : (
                <CapacityPanel
                  tiers={tiers}
                  currentAllowance={capacity?.activeVacancyAllowance ?? null}
                />
              )}
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
              <div className="plans-note">
                <Icon name="info" />
                <p>
                  <strong>Recorded only — nothing is blocked yet.</strong> Buying capacity is
                  stored against your account; the concurrent-posting cap is not yet enforced, so
                  it does not pause or block any posting today.
                </p>
              </div>
            </div>
          </section>

          <section className="plans-card">
            <div className="plans-card__head">
              <h2 className="plans-card__title">QUICK CREDIT PACKS</h2>
              <PortalLink className="plans-card__link" href="/credits" pendingLabel="Credits">
                View Credit Plans <Icon name={ACTION_ICON.next} />
              </PortalLink>
            </div>
            <div className="plans-card__body">
              {packs.length === 0 ? (
                <div className="state">
                  <span className="state__icon">
                    <Icon name={ACTION_ICON.credits} />
                  </span>
                  <h3 className="state__title">No credit packs on offer</h3>
                  <p className="state__body">
                    There is nothing to buy right now — your existing balance is unaffected.
                  </p>
                </div>
              ) : (
                <div className="plans-quick">
                  {packs.map((p) => (
                    <div className="plans-quick__item" key={p.code}>
                      <span className="plans-quick__label">PACK {p.credits}</span>
                      <span className="plans-quick__price bb-mono">
                        {p.listPriceInr !== undefined && p.listPriceInr > p.priceInr ? (
                          <s className="price-was">{formatInr(p.listPriceInr)}</s>
                        ) : null}
                        {formatInr(p.priceInr)}
                      </span>
                      {p.offerEndsAt ? (
                        <span className="price-offer">offer ends {p.offerEndsAt.slice(0, 10)}</span>
                      ) : null}
                      <span className="plans-quick__credits bb-mono">{p.credits} cr</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>

        <aside className="plans-col plans-col--side">
          <section className="plans-card">
            <div className="plans-card__head">
              <h2 className="plans-card__title">Posting Plans</h2>
              <span className="plans-pill plans-pill--green">ACTIVE PROMO</span>
            </div>
            <div className="plans-card__body">
              {postingTiers.length === 0 ? (
                <div className="state">
                  <span className="state__icon">
                    <Icon name={ACTION_ICON.posting} />
                  </span>
                  <h3 className="state__title">No posting plans on offer</h3>
                  <p className="state__body">
                    No plan is listed right now — any posting you have already published stays
                    live.
                  </p>
                </div>
              ) : (
                <div className="plans-planlist">
                  {postingTiers.map((t) => (
                    <div className="plans-plan" key={t.code}>
                      <p className="plans-plan__name">{t.code.replace(/_/g, " ")}</p>
                      <p className="plans-plan__price">Free</p>
                      <p className="plans-plan__meta">Valid for {t.validityDays} days</p>
                      <p className="plans-plan__enabled">
                        <Icon name="check-circle" /> Enabled
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="plans-card">
            <div className="plans-card__head">
              <h2 className="plans-card__title">APPLICANT QUOTA PER POSTING</h2>
            </div>
            <div className="plans-card__body">
              {capacity && capacity.postings.length > 0 ? (
                <div className="tablewrap" tabIndex={0} role="region" aria-label="Applicant quota per posting">
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
                            <PortalLink
                              className="capacity-link"
                              href={`/postings/${p.postingId}`}
                              pendingLabel={p.roleTitle}
                            >
                              {p.roleTitle}
                            </PortalLink>
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
                <div className="plans-empty">
                  <span className="plans-empty__icon">
                    <Icon name={ACTION_ICON.posting} />
                  </span>
                  <h3 className="plans-empty__title">No active postings yet</h3>
                  <p className="plans-empty__body">
                    You haven&rsquo;t published a posting yet. Once you do, applicant quotas will
                    appear here.
                  </p>
                  <PortalLink className="plans-empty__link" href="/postings/new" pendingLabel="New posting">
                    New posting <Icon name={ACTION_ICON.next} />
                  </PortalLink>
                </div>
              )}
            </div>
          </section>
        </aside>
      </div>

      <footer className="plans-foot">
        <span>© 2026 BadaBhai for Business. All rights reserved.</span>
      </footer>
    </div>
  );

}
