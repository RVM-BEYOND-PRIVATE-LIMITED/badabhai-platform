import type { AgencyEarnings } from "../../../../lib/contracts";
import { formatInr } from "../../../../lib/format";
import { accrualBasisLabel } from "../../../../lib/agency-view";
import { StatTile } from "../../../../components/ds";

/**
 * AGENCY EARNINGS panel (ADR-0022 Amendment 2, LIVE) — the agency's OWN referral-earnings
 * summary. SHARED (no "use client"): purely presentational, so it renders from the server
 * page. PII-free by construction — only ₹ amounts (mono tabular), counts, and the
 * config-sourced accrual basis. Amounts render via {@link formatInr} (whole ₹, en-IN).
 *
 * MOCK MONEY: a clear, always-visible disclosure states no real money is disbursed — the
 * whole supply-payout surface is mock in Phase 1 (CLAUDE.md §8; ADR-0022 Amendment 2).
 */
export function EarningsPanel({ earnings }: { earnings: AgencyEarnings }) {
  const {
    totalAccruedInr,
    requestableInr,
    inRequestInr,
    paidInr,
    accrualCount,
    rateBps,
    basisInr,
    windowDays,
  } = earnings;

  return (
    // A `.section`, not a `.panel`: the body is a run of StatTiles that already carry their own
    // surface, so a bordered frame around them would be a box inside a box.
    <section className="section">
      <div className="section__head">
        <h2 className="section__title">Your earnings</h2>
        {/* Accrual basis — read from config values the API returns, never hard-coded. */}
        <p className="section__sub">
          {accrualBasisLabel(rateBps, basisInr, windowDays)}. Accrued across{" "}
          <span className="bb-mono">{accrualCount}</span>{" "}
          {accrualCount === 1 ? "unlock" : "unlocks"} of workers you referred.
        </p>
      </div>

      {/* Mock-money disclosure — always visible where money is shown. */}
      <div className="alert alert--warning">
        <i className="ph ph-info alert__icon" aria-hidden="true" />
        <div className="alert__text">
          <p className="alert__title">No real money is disbursed</p>
          <p className="alert__body">
            Earnings, thresholds, and payouts here are mock figures for the alpha — no payment
            provider is connected.
          </p>
        </div>
      </div>

      {/* Four ₹ tiles — StatTile renders its value in mono tabular by design. */}
      <div className="stat-row">
        <StatTile label="Total accrued" value={formatInr(totalAccruedInr)} icon="wallet" />
        <StatTile label="Requestable" value={formatInr(requestableInr)} icon="hand-coins" />
        <StatTile label="In request" value={formatInr(inRequestInr)} icon="hourglass-medium" />
        <StatTile label="Paid" value={formatInr(paidInr)} icon="check-circle" />
      </div>
    </section>
  );
}
