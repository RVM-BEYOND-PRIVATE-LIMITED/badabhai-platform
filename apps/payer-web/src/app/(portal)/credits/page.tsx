import { getDashboard } from "../../../lib/payer-api";
import { offeredCreditPacks, unlockUnitPriceInr } from "../../../lib/pricing-config";
import type { Dashboard } from "../../../lib/contracts";
import { RetryButton } from "../../../components/retry-button";
import { CreditsPanel } from "./credits-panel";

export const dynamic = "force-dynamic";

/**
 * Credit top-up (ADR-0019 Phase 1 — MOCK ledger, no real money / XT5).
 *
 * Packs are read from CONFIG (`DEFAULT_CATALOG` via pricing-config), never
 * hardcoded. There is no Razorpay / card path on this surface; a real-payment path
 * is a HARD human gate (Decision D / §7).
 */
export default async function CreditsPage() {
  const packs = offeredCreditPacks();
  const unit = unlockUnitPriceInr();

  let dashboard: Dashboard | null = null;
  let error: string | null = null;
  try {
    dashboard = await getDashboard();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <>
      <h1 className="page-title">Credits</h1>
      <p className="page-sub">
        1 credit = 1 contact unlock{unit !== null ? ` (₹${unit} per unlock)` : ""}. Mock top-up —
        no real payment is taken in this staging preview.
      </p>

      {error ? (
        <p className="page-sub">
          <span className="badge badge-warn">Service unavailable</span> We couldn&rsquo;t load your
          balance right now. Please retry. <RetryButton />
        </p>
      ) : dashboard ? (
        <CreditsPanel packs={packs} balance={dashboard.credits.balance} />
      ) : null}

      <div className="note warn">
        <strong>Mock payments only.</strong> No card details are collected and no money moves. Real
        checkout (Razorpay) is a separate, human-gated rollout (ADR-0019 Decision D).
      </div>
    </>
  );
}
