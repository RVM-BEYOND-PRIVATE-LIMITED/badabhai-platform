import type { AgencyEarnings } from "../../../../lib/contracts";
import { formatInr } from "../../../../lib/format";
import { accrualBasisLabel } from "../../../../lib/agency-view";
import { Badge, Card, StatTile } from "../../../../components/ds";

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
    <section className="agency-section">
      <h2 className="agency-section__title">Your earnings</h2>

      {/* Mock-money disclosure — always visible where money is shown. */}
      <Card variant="flat" className="agency-invite__note">
        <Badge tone="warning" upper>
          Mock
        </Badge>{" "}
        <strong>No real money is disbursed.</strong> Earnings, thresholds, and payouts here
        are mock figures for the alpha — no payment provider is connected.
      </Card>

      {/* Four ₹ tiles — StatTile renders its value in mono tabular by design. */}
      <div className="agency-stats">
        <StatTile label="Total accrued" value={formatInr(totalAccruedInr)} icon="wallet" />
        <StatTile label="Requestable" value={formatInr(requestableInr)} icon="hand-coins" />
        <StatTile label="In request" value={formatInr(inRequestInr)} icon="hourglass-medium" />
        <StatTile label="Paid" value={formatInr(paidInr)} icon="check-circle" />
      </div>

      {/* Accrual basis — read from config values the API returns, never hard-coded. */}
      <p className="agency-section__sub">
        {accrualBasisLabel(rateBps, basisInr, windowDays)}. Accrued across{" "}
        <span className="bb-mono">{accrualCount}</span>{" "}
        {accrualCount === 1 ? "unlock" : "unlocks"} of workers you referred.
      </p>
    </section>
  );
}
