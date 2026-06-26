import { getCreditTopUps, getDashboard } from "../../../lib/payer-api";
import {
  creditValidityMonths,
  lowBalanceThreshold,
  offeredCreditPacks,
  unlockUnitPriceInr,
} from "../../../lib/pricing-config";
import { buildTransactionHistory, creditExpirySchedule } from "../../../lib/credit-history";
import type { CreditTopUp, Dashboard, UnlockHistoryItem } from "../../../lib/contracts";
import { RetryButton } from "../../../components/retry-button";
import { CreditsPanel } from "./credits-panel";

export const dynamic = "force-dynamic";

/** ISO → yyyy-mm-dd for display; echoes the input on a parse failure. */
function day(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().slice(0, 10);
}

/**
 * Credit top-up + history (ADR-0019 Phase 1 — MOCK ledger, no real money / XT5).
 *
 * Packs and the per-unlock unit price are read from CONFIG (`DEFAULT_CATALOG` via
 * pricing-config), never hardcoded. There is no Razorpay / card path on this surface; a
 * real-payment path is a HARD human gate (Decision D / §7).
 *
 * This page adds, all PII-free (ids/amounts only — never a worker name/phone):
 *  - a spend/top-up HISTORY aggregating the caller's OWN unlock spend (GET /payer/unlocks)
 *    + mock-ledger top-ups, merged by the pure `buildTransactionHistory` helper;
 *  - a proactive LOW-BALANCE nudge whose threshold is read from config (`lowBalanceThreshold`);
 *  - a 12-month credit-EXPIRY schedule derived from purchase timestamps (`creditExpirySchedule`).
 */
export default async function CreditsPage() {
  const packs = offeredCreditPacks();
  const unit = unlockUnitPriceInr();
  const threshold = lowBalanceThreshold();

  let dashboard: Dashboard | null = null;
  let error: string | null = null;
  try {
    dashboard = await getDashboard();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // The mock-ledger top-ups are a SEPARATE concern from the live balance — fetched in their
  // own try/catch so a ledger hiccup never blanks the balance/packs (C2 decoupling).
  let topUps: CreditTopUp[] = [];
  try {
    topUps = await getCreditTopUps();
  } catch {
    topUps = [];
  }

  // Credit validity window comes from config (default 12 months) — never a page literal; it
  // is distinct from the catalog per-unlock access `windowDays` (see pricing-config).
  const validityMonths = creditValidityMonths();
  const unlocks: UnlockHistoryItem[] = dashboard?.unlocks ?? [];
  const history = buildTransactionHistory({ unlocks, topUps });
  const expiry = creditExpirySchedule(topUps, validityMonths);
  const balance = dashboard?.credits.balance ?? null;
  const lowBalance = balance !== null && balance < threshold;

  return (
    <>
      <h1 className="page-title">Credits</h1>
      <p className="page-sub">
        1 credit = 1 contact unlock{unit !== null ? ` (₹${unit} per unlock)` : ""}. Mock top-up —
        no real payment is taken in this staging preview.
      </p>

      {lowBalance ? (
        <div className="note warn">
          <strong>You&rsquo;re running low — {balance} credit{balance === 1 ? "" : "s"} left.</strong>{" "}
          Top up below so you can keep unlocking candidates. (We nudge you below {threshold} credits —
          this is your own balance, never a signal about any candidate.)
        </div>
      ) : null}

      {error ? (
        <p className="page-sub">
          <span className="badge badge-warn">Service unavailable</span> We couldn&rsquo;t load your
          balance right now. Please retry. <RetryButton />
        </p>
      ) : dashboard ? (
        <CreditsPanel packs={packs} balance={dashboard.credits.balance} />
      ) : null}

      {history.length > 0 ? (
        <section style={{ marginTop: 24 }}>
          <h2 className="page-title" style={{ fontSize: "1.1rem" }}>
            History
          </h2>
          <p className="page-sub">
            Your own credit movements — top-ups and unlock spends. Ids and amounts only; no
            candidate identity is ever shown.
          </p>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Credits</th>
                <th>Amount</th>
                <th>Ref</th>
              </tr>
            </thead>
            <tbody>
              {history.map((t) => (
                <tr key={t.id}>
                  <td className="mono">{day(t.at)}</td>
                  <td>
                    {t.kind === "topup" ? (
                      <span className="badge badge-ok">Top-up</span>
                    ) : (
                      <span className="badge">Unlock</span>
                    )}
                  </td>
                  <td className="mono">
                    {t.credits > 0 ? `+${t.credits}` : t.credits}
                  </td>
                  <td className="mono">
                    {t.kind === "topup" && t.priceInr !== undefined
                      ? `₹${t.priceInr.toLocaleString("en-IN")}`
                      : "—"}
                  </td>
                  <td className="mono">{t.id.slice(0, 8)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {expiry.length > 0 ? (
        <section style={{ marginTop: 24 }}>
          <h2 className="page-title" style={{ fontSize: "1.1rem" }}>
            Credit expiry
          </h2>
          <p className="page-sub">
            Purchased credits expire {validityMonths} months after the top-up. Soonest first.
          </p>
          <table>
            <thead>
              <tr>
                <th>Credits</th>
                <th>Purchased</th>
                <th>Expires</th>
              </tr>
            </thead>
            <tbody>
              {expiry.map((e) => (
                <tr key={e.topUpId}>
                  <td className="mono">{e.credits}</td>
                  <td className="mono">{day(e.purchasedAt)}</td>
                  <td className="mono">{day(e.expiresAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <div className="note warn" style={{ marginTop: 24 }}>
        <strong>Mock payments only.</strong> No card details are collected and no money moves. Real
        checkout (Razorpay) is a separate, human-gated rollout (ADR-0019 Decision D).
      </div>
    </>
  );
}
