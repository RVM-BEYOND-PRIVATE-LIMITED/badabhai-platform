import Link from "next/link";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { getCapacity } from "../../../lib/payer-api";
import { requirePayer } from "../../../lib/auth";
import { postingRoutes } from "../../../lib/posting-routes";
import { getLiveCatalog } from "../../../lib/live-catalog";
import { hiringCapacityTiers } from "../../../lib/pricing-config";
import type { Capacity } from "../../../lib/contracts";
import { Badge, Card, StatTile } from "../../../components/ds";
import { CachedPricingNote } from "../../../components/cached-pricing-note";
import { PageHeader } from "../../../components/page-header";
import { RetryButton } from "../../../components/retry-button";
import { CapacityPanel } from "./capacity-panel";

export const dynamic = "force-dynamic";

/** The per-posting table's heading — also the NAME of its scroll region (aria-labelledby). */
const POSTINGS_TABLE_HEADING_ID = "capacity-postings-table-title";

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
 *
 * ONE ENTRY POINT (owner ruling 2026-10-01): this route is KEPT (the at-capacity alert on New
 * posting links here) but it is the Hiring-capacity part of Plans & capacity, not a peer of it:
 * it has no nav entry (the rail lights "Plans & capacity" here), its header goes back up to
 * /plans, and its title names the part it shows.
 */
export default async function CapacityPage() {
  const session = await requirePayer();
  const isAgency = session.role === "agent";
  const posting = postingRoutes(isAgency);
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

  // `.capacity-page` only NAMESPACES this screen's layout rules (the "W3-B" block in
  // globals.css) — it carries no styling of its own.
  return (
    <div className="capacity-page">
      <PageHeader
        back={{ href: "/plans", label: "Plans & capacity" }}
        title="Hiring capacity"
        description="How many postings you can run at once, and how many applicants each may disclose."
      />

      {error ? (
        <Card>
          <div className="state state--error">
            <span className="state__icon">
              <Icon name="warning-circle" />
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

          <section className="section">
            <div className="section__head">
              <div className="section__text">
                <h2 className="section__title">Add capacity</h2>
                <p className="section__sub">
                  Your active-posting count above is{" "}
                  <strong>live from the enforcement engine</strong> — it drives whether you are at
                  capacity. Adding capacity raises your concurrent allowance and resumes any
                  paused postings. Prices are <strong>mock</strong> — no real payment is taken.
                </p>
              </div>
            </div>
            {!live ? <CachedPricingNote /> : null}
            <CapacityPanel tiers={tiers} />
            <div className="alert alert--info">
              <Icon name="info" className="alert__icon" />
              <div className="alert__text">
                <p className="alert__title">Recorded only — nothing is blocked yet.</p>
                <p className="alert__body">
                  Buying capacity is stored against your account; the concurrent-posting cap is
                  not yet enforced, so it does not pause or block any posting today. Mock
                  payments only — no money moves.
                </p>
              </div>
            </div>
          </section>

          <section className="panel panel--table">
            <div className="panel__head">
              <div className="panel__text">
                <h2 className="panel__title" id={POSTINGS_TABLE_HEADING_ID}>
                  Applicant quota per posting
                </h2>
                <p className="panel__sub">
                  Your concurrent allowance and active count above are <strong>live</strong> from
                  the backend enforcement engine. The per-posting rows below reflect{" "}
                  <strong>backend-seeded plans only</strong> and do <strong>not</strong> drive
                  that count — they will become live once the create-posting backend endpoint
                  lands.
                </p>
              </div>
            </div>
            <div className="panel__body">
              {capacity.postings.length === 0 ? (
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
              ) : (
                <div
                  className="tablewrap"
                  tabIndex={0}
                  role="region"
                  aria-labelledby={POSTINGS_TABLE_HEADING_ID}
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
                            {/* Company postings; an agency is never linked into the company
                                posting surface, so for an agent the role is text. */}
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
              )}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
