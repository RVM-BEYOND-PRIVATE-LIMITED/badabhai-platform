import { getCreditTopUps, getDashboard } from "../../../lib/payer-api";
import { requireOwner } from "../../../lib/auth/org-roles";
import {
  creditValidityMonths,
  lowBalanceThreshold,
  offeredCreditPacks,
  unlockUnitPriceInr,
} from "../../../lib/pricing-config";
import { buildTransactionHistory, creditExpirySchedule } from "../../../lib/credit-history";
import { getLiveCatalog } from "../../../lib/live-catalog";
import { payerServerConfig } from "../../../lib/server-config";
import { formatInr } from "../../../lib/format";
import { opaqueId } from "../../../lib/masking";
import type { CreditTopUp, Dashboard, UnlockHistoryItem } from "../../../lib/contracts";
import { Badge, Card, StatTile } from "../../../components/ds";
import { CachedPricingNote } from "../../../components/cached-pricing-note";
import { RetryButton } from "../../../components/retry-button";
import { CreditsPanel } from "./credits-panel";

export const dynamic = "force-dynamic";

/** ISO → yyyy-mm-dd for display; echoes the input on a parse failure. */
function day(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().slice(0, 10);
}

/**
 * Credit top-up + history (ADR-0019 Phase 1 — MOCK ledger, no real money / XT5) — composed
 * onto the UI-1 page spine (`page-head` / `stat-row` / `section` / `panel--table` / `alert` /
 * `state`). PRESENTATION ONLY: data + config + RBAC + copy semantics are unchanged.
 *
 * Packs and the per-unlock unit price are read from the LIVE catalog (D-6:
 * `getLiveCatalog` → GET /payer/pricing/catalog via pricing-config), never hardcoded —
 * an ops price edit shows here without a rebuild. On a catalog fetch failure the page
 * degrades to the compile-time defaults with the subtle cached-pricing note (fail-open
 * is safe: the server re-resolves the real price at purchase, XT5).
 * All ₹ / counts render in mono tabular.
 *
 * MOCK vs REAL is decided SERVER-SIDE by `payerServerConfig().paymentsEnableReal` and
 * passed down as one boolean. The client cannot choose its own mode, and the browser only
 * ever learns the PUBLIC `rzp_*` key id — which arrives on the order response, not from
 * this page and not from any `NEXT_PUBLIC_*` value. The copy below follows the flag, so
 * the page never claims "no real payment is taken" while a real charge is live.
 *
 * PII-free (ids/amounts only — never a worker name/phone). ORG-RBAC: billing/wallet is an
 * OWNER-only surface — `requireOwner()` gates it SERVER-SIDE (a Recruiter gets a neutral 404).
 */
export default async function CreditsPage() {
  await requireOwner(); // Owner-only billing/wallet — Recruiter ⇒ neutral 404 (no-oracle).

  // Server-resolved payment mode. Fail-closed: anything but an explicit "true" is MOCK.
  const realPayments = payerServerConfig().paymentsEnableReal;
  const { products, live } = await getLiveCatalog();
  const packs = offeredCreditPacks(products);
  const unit = unlockUnitPriceInr(products);
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

  // Credit validity window comes from config (default 12 months) — never a page literal.
  const validityMonths = creditValidityMonths();
  const unlocks: UnlockHistoryItem[] = dashboard?.unlocks ?? [];
  const history = buildTransactionHistory({ unlocks, topUps });
  const expiry = creditExpirySchedule(topUps, validityMonths);
  const balance = dashboard?.credits.balance ?? null;
  const lowBalance = balance !== null && balance < threshold;

  return (
    <>
      <div className="page-head">
        <div className="page-head__text">
          <h1 className="page-head__title">Credits</h1>
          <p className="page-head__sub">
            1 credit = 1 contact unlock{unit !== null ? ` (${formatInr(unit)} per unlock)` : ""}.{" "}
            {realPayments
              ? "Pay securely via Razorpay — credits are added as soon as the payment is confirmed."
              : "Mock top-up — no real payment is taken in this staging preview."}
          </p>
        </div>
      </div>

      {!live ? <CachedPricingNote /> : null}

      {lowBalance ? (
        <div className="alert alert--warning">
          <i className="ph ph-warning alert__icon" aria-hidden="true" />
          <div className="alert__text">
            <p className="alert__title">Running low</p>
            <p className="alert__body">
              You&rsquo;re running low — <span className="bb-mono">{balance}</span> credit
              {balance === 1 ? "" : "s"} left. Top up below to keep unlocking candidates. We nudge
              below {threshold} credits — this is your own balance, never a signal about any
              candidate.
            </p>
          </div>
        </div>
      ) : null}

      {error ? (
        <Card>
          <div className="state state--error">
            <span className="state__icon">
              <i className="ph ph-warning-circle" aria-hidden="true" />
            </span>
            <h2 className="state__title">Service unavailable</h2>
            <p className="state__body">
              We couldn&rsquo;t load your balance right now. Nothing has changed — please retry.
            </p>
            <div className="state__actions">
              <RetryButton />
            </div>
          </div>
        </Card>
      ) : dashboard ? (
        <>
          <div className="stat-row">
            <StatTile
              label="Credit balance"
              value={dashboard.credits.balance}
              icon="wallet"
              caption={
                unit !== null ? (
                  <>
                    <span className="bb-mono">{formatInr(unit)}</span> per unlock
                  </>
                ) : undefined
              }
            />
          </div>
          <section className="section">
            <div className="section__head">
              <h2 className="section__title">Top up</h2>
              <p className="section__sub">
                Pick a pack — the credits land in the balance above and can be spent on any
                contact unlock.
              </p>
            </div>
            <CreditsPanel packs={packs} real={realPayments} />
          </section>
        </>
      ) : null}

      <section className="panel panel--table">
        <div className="panel__head">
          <h2 className="panel__title">History</h2>
          <p className="panel__sub">
            Your own credit movements — top-ups and unlock spends. Ids and amounts only; no
            candidate identity is ever shown.
          </p>
        </div>
        <div className="panel__body">
          {history.length > 0 ? (
            <div className="tablewrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th className="num">Credits</th>
                    <th className="num">Amount</th>
                    <th>Ref</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((t) => (
                    <tr key={t.id}>
                      <td className="mono">{day(t.at)}</td>
                      <td>
                        {t.kind === "topup" ? (
                          <Badge tone="success">Top-up</Badge>
                        ) : (
                          <Badge tone="neutral">Unlock</Badge>
                        )}
                      </td>
                      <td className="num">{t.credits > 0 ? `+${t.credits}` : t.credits}</td>
                      <td className="num">
                        {t.kind === "topup" && t.priceInr !== undefined
                          ? formatInr(t.priceInr)
                          : "—"}
                      </td>
                      <td className="mono">{opaqueId(t.id)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : error ? (
            // The balance read is what failed, so the unlock half of the ledger is missing —
            // say that rather than claiming there were never any movements.
            <div className="state state--error">
              <span className="state__icon">
                <i className="ph ph-warning-circle" aria-hidden="true" />
              </span>
              <h3 className="state__title">History unavailable</h3>
              <p className="state__body">
                We couldn&rsquo;t load your credit movements right now. Nothing has changed —
                please retry.
              </p>
              <div className="state__actions">
                <RetryButton />
              </div>
            </div>
          ) : (
            <div className="state">
              <span className="state__icon">
                <i className="ph ph-receipt" aria-hidden="true" />
              </span>
              <h3 className="state__title">No credit movements yet</h3>
              <p className="state__body">
                Top-ups and unlock spends land here the moment they happen. Buy a pack above to
                get started.
              </p>
            </div>
          )}
        </div>
      </section>

      <section className="panel panel--table">
        <div className="panel__head">
          <h2 className="panel__title">Credit expiry</h2>
          <p className="panel__sub">
            Purchased credits expire {validityMonths} months after the top-up. Soonest first.
          </p>
        </div>
        <div className="panel__body">
          {expiry.length > 0 ? (
            <div className="tablewrap">
              <table className="table">
                <thead>
                  <tr>
                    <th className="num">Credits</th>
                    <th>Purchased</th>
                    <th>Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {expiry.map((e) => (
                    <tr key={e.topUpId}>
                      <td className="num">{e.credits}</td>
                      <td className="mono">{day(e.purchasedAt)}</td>
                      <td className="mono">{day(e.expiresAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="state">
              <span className="state__icon">
                <i className="ph ph-hourglass" aria-hidden="true" />
              </span>
              <h3 className="state__title">Nothing expiring yet</h3>
              <p className="state__body">
                Credits you buy show their purchase and expiry dates here, soonest first.
              </p>
            </div>
          )}
        </div>
      </section>

      {realPayments ? (
        <div className="alert alert--info">
          <i className="ph ph-shield-check alert__icon" aria-hidden="true" />
          <div className="alert__text">
            <p className="alert__title">Payments by Razorpay.</p>
            <p className="alert__body">
              Card and UPI details are entered on Razorpay&rsquo;s secure form — BadaBhai never
              sees or stores them. Credits are added once the payment is confirmed.
            </p>
          </div>
        </div>
      ) : (
        <div className="alert alert--info">
          <i className="ph ph-info alert__icon" aria-hidden="true" />
          <div className="alert__text">
            <p className="alert__title">Mock payments only.</p>
            <p className="alert__body">
              No card details are collected and no money moves. Real checkout (Razorpay) is a
              separate, human-gated rollout (ADR-0019 Decision D).
            </p>
          </div>
        </div>
      )}
    </>
  );
}
