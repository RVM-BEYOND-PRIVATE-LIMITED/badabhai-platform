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
import { formatInr } from "../../../lib/format";
import { opaqueId } from "../../../lib/masking";
import type { CreditTopUp, Dashboard, UnlockHistoryItem } from "../../../lib/contracts";
import { Badge, Card, StatTile, Toast } from "../../../components/ds";
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
 * Credit top-up + history (ADR-0019 Phase 1 — MOCK ledger, no real money / XT5) — DS1.4
 * re-skin onto the design system (visual only; data + config + RBAC unchanged).
 *
 * Packs and the per-unlock unit price are read from the LIVE catalog (D-6:
 * `getLiveCatalog` → GET /payer/pricing/catalog via pricing-config), never hardcoded —
 * an ops price edit shows here without a rebuild. On a catalog fetch failure the page
 * degrades to the compile-time defaults with the subtle cached-pricing note (fail-open
 * is safe: the server re-resolves the real price at purchase, XT5). There is no
 * Razorpay / card path; a real-payment path is a HARD human gate (Decision D / §7).
 * All ₹ / counts render in mono tabular.
 *
 * PII-free (ids/amounts only — never a worker name/phone). ORG-RBAC: billing/wallet is an
 * OWNER-only surface — `requireOwner()` gates it SERVER-SIDE (a Recruiter gets a neutral 404).
 */
export default async function CreditsPage() {
  await requireOwner(); // Owner-only billing/wallet — Recruiter ⇒ neutral 404 (no-oracle).

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
      <h1 className="dash-title">Credits</h1>
      <p className="dash-sub">
        1 credit = 1 contact unlock{unit !== null ? ` (${formatInr(unit)} per unlock)` : ""}. Mock top-up —
        no real payment is taken in this staging preview.
      </p>

      {!live ? <CachedPricingNote /> : null}

      {lowBalance ? (
        <Card variant="outline" className="credits-alert">
          <Badge tone="warning" upper>
            Running low
          </Badge>
          <p className="credits-alert__msg">
            You&rsquo;re running low — <span className="bb-mono">{balance}</span> credit
            {balance === 1 ? "" : "s"} left. Top up below to keep unlocking candidates. We nudge
            below {threshold} credits — this is your own balance, never a signal about any candidate.
          </p>
        </Card>
      ) : null}

      {error ? (
        <Card variant="outline" className="credits-state">
          <Badge tone="warning" upper>
            Service unavailable
          </Badge>
          <p className="credits-state__msg">
            We couldn&rsquo;t load your balance right now. Please retry.
          </p>
          <RetryButton />
        </Card>
      ) : dashboard ? (
        <>
          <div className="credits-stats">
            <StatTile
              label="Credit balance"
              value={dashboard.credits.balance}
              icon="wallet"
              delta={
                unit !== null ? (
                  <>
                    <span className="bb-mono">{formatInr(unit)}</span> per unlock
                  </>
                ) : undefined
              }
              deltaDir="flat"
            />
          </div>
          <CreditsPanel packs={packs} />
        </>
      ) : null}

      {history.length > 0 ? (
        <section className="credits-section">
          <h2 className="credits-section__title">History</h2>
          <p className="dash-sub">
            Your own credit movements — top-ups and unlock spends. Ids and amounts only; no
            candidate identity is ever shown.
          </p>
          <Card padding="none" className="credits-table-card">
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
                    <td className="bb-mono">{day(t.at)}</td>
                    <td>
                      {t.kind === "topup" ? (
                        <Badge tone="success">Top-up</Badge>
                      ) : (
                        <Badge tone="neutral">Unlock</Badge>
                      )}
                    </td>
                    <td className="bb-mono">{t.credits > 0 ? `+${t.credits}` : t.credits}</td>
                    <td className="bb-mono">
                      {t.kind === "topup" && t.priceInr !== undefined
                        ? formatInr(t.priceInr)
                        : "—"}
                    </td>
                    <td className="bb-mono">{opaqueId(t.id)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </section>
      ) : null}

      {expiry.length > 0 ? (
        <section className="credits-section">
          <h2 className="credits-section__title">Credit expiry</h2>
          <p className="dash-sub">
            Purchased credits expire {validityMonths} months after the top-up. Soonest first.
          </p>
          <Card padding="none" className="credits-table-card">
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
                    <td className="bb-mono">{e.credits}</td>
                    <td className="bb-mono">{day(e.purchasedAt)}</td>
                    <td className="bb-mono">{day(e.expiresAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </section>
      ) : null}

      <div className="credits-nudge">
        <Toast tone="neutral">
          <strong>Mock payments only.</strong> No card details are collected and no money moves.
          Real checkout (Razorpay) is a separate, human-gated rollout (ADR-0019 Decision D).
        </Toast>
      </div>
    </>
  );
}
